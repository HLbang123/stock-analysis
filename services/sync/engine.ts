'use client';

/**
 * 云同步引擎（客户端单例，全站生效）
 * - 首台设备 enableCloud：生成身份 → 上传快照（零摩擦，无码可见）
 * - 加设备 redeemPairCode：6位配对码取回 syncKey → 拉取快照
 * - 自动同步 L2：store 变化 debounce 15s 上传 + 页面可见时 60s 版本轮询 + 激活即查
 * - 回声抑制：applyRemoteBlob 期间 applyingRemote=true，订阅回调跳过上传（否则多设备互拉互传死循环）
 * - 冲突 LWW：上传带 baseVersion，409 → 拉取远端覆盖 + toast 告知
 * - 内容 hash 防空传：内容没变跳过上传（防 chatMessages/lastSession 等不同步字段扰动）
 */

import { useStockStore } from '@/store';
import { useAiStore, type AiProfile, type AiAnalysisRecord } from '@/store/ai-store';
import { useSyncStore } from '@/store/sync-store';
import type { Stock, WatchlistGroup } from '@/types';
import { toast } from 'sonner';
import {
  b64decode, b64encode, decryptBlob, encryptBlob, generateIdentity, generatePairCode,
  isValidPairCode, sha256Hex, unwrapKeyWithCode, wrapKeyWithCode,
} from '@/lib/sync-crypto';

/** 快照信封（blob schema v1；加同步内容 → v2 + applyRemoteBlob 按 v 适配） */
interface SyncBlobV1 {
  v: 1;
  packedAt: number;
  data: {
    watchlist: Stock[];
    groups: WatchlistGroup[];
    profiles: AiProfile[];
    currentProfileId: string;
    history: AiAnalysisRecord[];
  };
}

// ---- 模块级引擎状态（不持久化） ----
let applyingRemote = false;
let lastUploadedHash = '';
let uploadTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let initialized = false;

const UPLOAD_DEBOUNCE_MS = 15_000;
const POLL_MS = 60_000;
const BLOB_VERSION_CAP = 1_500_000; // 服务器 blob 上限(字符)，本地防御性对齐

function getKeyBytes(): Uint8Array | null {
  const b64 = useSyncStore.getState().syncKeyB64;
  return b64 ? b64decode(b64) : null;
}

/** 打包当前数据为 JSON（hash 变更检测用） */
export function packSnapshot(): string | null {
  const s = useStockStore.getState();
  const a = useAiStore.getState();
  const blob: SyncBlobV1 = {
    v: 1,
    packedAt: Date.now(),
    data: {
      watchlist: s.watchlist,
      groups: s.groups,
      profiles: a.profiles,
      currentProfileId: a.currentProfileId,
      history: a.history,
    },
  };
  return JSON.stringify(blob);
}

/** 应用远端快照（响应式 setState + persist 自动落盘；回声抑制见模块头注释） */
function applyRemoteBlob(plain: string) {
  let blob: SyncBlobV1;
  try {
    blob = JSON.parse(plain) as SyncBlobV1;
  } catch { return; }
  if (blob.v !== 1 || !blob.data) return;
  const d = blob.data;
  applyingRemote = true;
  try {
    // 字段规整对齐现有迁移口径（default 组已废弃 → 归位未分组），persist 侧不再重复迁移
    useStockStore.setState({
      watchlist: (Array.isArray(d.watchlist) ? d.watchlist : []).map((s) => ({
        ...s, groupId: s.groupId === 'default' ? undefined : s.groupId,
      })),
      groups: (Array.isArray(d.groups) ? d.groups : []).filter((g) => g.id !== 'default'),
    });
    useAiStore.setState({
      profiles: Array.isArray(d.profiles) ? d.profiles : [],
      currentProfileId: typeof d.currentProfileId === 'string' ? d.currentProfileId : '',
      history: Array.isArray(d.history) ? d.history : [],
    });
  } finally {
    applyingRemote = false;
  }
}

/** 拉取远端快照并覆盖本地（返回是否实际应用） */
export async function pull(): Promise<boolean> {
  const st = useSyncStore.getState();
  if (!st.enabled || !st.syncId) return false;
  const key = getKeyBytes();
  if (!key) return false;
  try {
    const res = await fetch(`/api/sync?syncId=${encodeURIComponent(st.syncId)}`);
    if (!res.ok) return false;
    const data = await res.json();
    if (!data.blob || typeof data.blob !== 'string') return false;
    const plain = await decryptBlob(key, data.blob);
    applyRemoteBlob(plain);
    lastUploadedHash = ''; // 远端内容与本地 hash 未必一致，置空强制下次变更重算
    useSyncStore.getState().markSynced(data.version, Date.now());
    return true;
  } catch {
    return false;
  }
}

/** 版本轮询：云端有新版本则拉取 */
export async function checkAndPull(): Promise<boolean> {
  const st = useSyncStore.getState();
  if (!st.enabled || !st.syncId) return false;
  try {
    const res = await fetch(`/api/sync?syncId=${encodeURIComponent(st.syncId)}&versionOnly=1`);
    if (!res.ok) return false;
    const data = await res.json();
    if (typeof data.version === 'number' && data.version > st.lastVersion) return pull();
  } catch { /* 轮询失败静默 */ }
  return false;
}

/** 上传本地快照；409 = 另一设备先写了 → 拉取远端（LWW 远端赢）并 toast 告知 */
export async function upload(force = false): Promise<'ok' | 'conflict' | 'error'> {
  const st = useSyncStore.getState();
  if (!st.enabled || !st.syncId) return 'error';
  const key = getKeyBytes();
  if (!key) return 'error';
  const plain = packSnapshot();
  if (!plain) return 'error';
  const hash = await sha256Hex(plain);
  if (!force && hash === lastUploadedHash) return 'ok'; // 内容没变跳过（不同步字段扰动不产生空传）
  if (plain.length > BLOB_VERSION_CAP) {
    useSyncStore.getState().setLastError('数据量超过上限，同步失败');
    return 'error';
  }
  try {
    const blob = await encryptBlob(key, plain);
    const res = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ syncId: st.syncId, keyHash: st.keyHash, baseVersion: st.lastVersion, blob }),
    });
    if (res.status === 409) {
      const pulled = await pull();
      if (pulled) toast.info('已拉取另一设备的更新');
      return 'conflict';
    }
    if (!res.ok) {
      useSyncStore.getState().setLastError('上传失败，稍后自动重试');
      return 'error';
    }
    const data = await res.json();
    lastUploadedHash = hash;
    useSyncStore.getState().markSynced(data.version, Date.now());
    return 'ok';
  } catch {
    useSyncStore.getState().setLastError('上传失败，稍后自动重试');
    return 'error';
  }
}

/** 首台设备开启：生成身份并首次上传（无码可见） */
export async function enableCloud(): Promise<boolean> {
  const { syncId, syncKeyBytes } = generateIdentity();
  const keyB64 = b64encode(syncKeyBytes);
  const keyHash = await sha256Hex(keyB64);
  useSyncStore.getState().setIdentity(syncId, keyB64, keyHash);
  lastUploadedHash = '';
  const r = await upload(true);
  if (r === 'error') { useSyncStore.getState().clearIdentity(); return false; }
  return true;
}

/** 新设备：输入配对码取回身份并拉取快照 */
export async function redeemPairCode(code: string): Promise<{ ok: boolean; error?: string }> {
  const clean = code.replace(/\s/g, '');
  if (!isValidPairCode(clean)) return { ok: false, error: '请输入 6 位数字配对码' };
  const codeHash = await sha256Hex(clean);
  try {
    const res = await fetch(`/api/sync/pair?codeHash=${codeHash}`);
    if (res.status === 404) return { ok: false, error: '配对码无效或已过期，请在原设备重新生成' };
    if (!res.ok) return { ok: false, error: '配对失败，请稍后重试' };
    const data = await res.json();
    const syncKeyBytes = await unwrapKeyWithCode(clean, data.wrappedKey);
    const keyB64 = b64encode(syncKeyBytes);
    const keyHash = await sha256Hex(keyB64);
    useSyncStore.getState().setIdentity(data.syncId, keyB64, keyHash);
    lastUploadedHash = '';
    await pull();
    return { ok: true };
  } catch {
    return { ok: false, error: '配对码无效或已过期，请在原设备重新生成' };
  }
}

/** 已同步设备：生成 6 位配对码（10 分钟 TTL）供新设备输入 */
export async function createPairCode(): Promise<{ code: string; expiresAt: number } | { error: string }> {
  const st = useSyncStore.getState();
  if (!st.enabled || !st.syncId) return { error: '请先开启云同步' };
  const key = getKeyBytes();
  if (!key) return { error: '同步身份缺失，请重新开启' };
  try {
    const code = generatePairCode();
    const codeHash = await sha256Hex(code);
    const wrappedKey = await wrapKeyWithCode(code, key);
    const res = await fetch('/api/sync/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codeHash, syncId: st.syncId, wrappedKey }),
    });
    if (!res.ok) return { error: '生成失败，请稍后重试' };
    return { code, expiresAt: Date.now() + 10 * 60 * 1000 };
  } catch {
    return { error: '生成失败，请稍后重试' };
  }
}

/** 关闭同步：删服务器快照 + 清本地身份（本地数据保留） */
export async function disableCloud(): Promise<void> {
  const st = useSyncStore.getState();
  if (st.enabled && st.syncId) {
    try {
      await fetch('/api/sync', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ syncId: st.syncId, keyHash: st.keyHash }),
      });
    } catch { /* 删除失败不阻断本地关闭 */ }
  }
  useSyncStore.getState().clearIdentity();
  lastUploadedHash = '';
}

/** 引擎初始化（幂等，SyncEngine 组件挂载时调用） */
export function initSyncEngine() {
  if (initialized) return;
  initialized = true;

  const scheduleUpload = () => {
    const st = useSyncStore.getState();
    if (!st.enabled || !st.autoSync || applyingRemote) return;
    if (uploadTimer) clearTimeout(uploadTimer);
    uploadTimer = setTimeout(() => {
      uploadTimer = null;
      upload();
    }, UPLOAD_DEBOUNCE_MS);
  };

  useStockStore.subscribe(scheduleUpload);
  useAiStore.subscribe(scheduleUpload);

  const tick = () => {
    const st = useSyncStore.getState();
    if (st.enabled && st.autoSync && document.visibilityState === 'visible') {
      checkAndPull();
    }
  };
  pollTimer = setInterval(tick, POLL_MS);
  document.addEventListener('visibilitychange', tick);

  // 启动即查一次（跨标签页/刷新后补上离线期间的更新）
  if (useSyncStore.getState().enabled && useSyncStore.getState().autoSync) tick();
}
