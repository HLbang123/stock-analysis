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
import { useShareStore } from '@/store/share-store';
import { useSyncStore, defaultDeviceName, type SyncDeviceEntry } from '@/store/sync-store';
import type { Stock, WatchlistGroup } from '@/types';
import { toast } from 'sonner';
import {
  b64decode, b64encode, decryptBlob, encryptBlob, generateIdentity, generatePairCode,
  isValidPairCode, sha256Hex, unwrapKeyWithCode, wrapKeyWithCode,
} from '@/lib/sync-crypto';

/** 我的分享状态（随 blob 走，多设备接管同一分享码，不再各开新码造孤儿）。
 *  v3 软加字段：老版本客户端读 blob 忽略未知键，互不干扰；token 与 syncKey 同信任域 */
export interface SyncShareState {
  code: string;
  token: string;
  displayName: string;
  groupIds: string[];
  mode: 'manual' | 'auto';
  expireDays: number | null;
}

/** 快照信封（blob v3：多组映射，groups 带 stockCodes、标的无 groupId；v1/v2 兼容读取迁移）。加同步内容 → v4 + applyRemoteBlob 按 v 适配（纯新增可选键可不升 v） */
interface SyncBlobV3 {
  v: 1 | 2 | 3;
  packedAt: number;
  data: {
    watchlist: Stock[];
    groups: WatchlistGroup[];
    profiles: AiProfile[];
    currentProfileId: string;
    history: AiAnalysisRecord[];
    devices?: SyncDeviceEntry[];
    share?: SyncShareState;
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

/** 本机在共享清单里的当前条目（含最新同步时间） */
function selfEntry(): SyncDeviceEntry {
  const st = useSyncStore.getState();
  if (!st.deviceId) st.ensureDevice();
  const s = useSyncStore.getState();
  return { id: s.deviceId, name: s.deviceName || defaultDeviceName(), lastSyncedAt: Date.now() };
}

/** 把本机条目 upsert 进清单（存在则更新时间，不存在则追加） */
function upsertSelf(list: SyncDeviceEntry[], self: SyncDeviceEntry): SyncDeviceEntry[] {
  const i = list.findIndex((d) => d.id === self.id);
  if (i >= 0) {
    const next = [...list];
    next[i] = self;
    return next;
  }
  return [...list, self];
}

/** 打包当前数据为 JSON（hash 变更检测用；设备 lastSyncedAt 属易变字段，不算进 hash，防扰动空传） */
export function packSnapshot(): string | null {
  const s = useStockStore.getState();
  const a = useAiStore.getState();
  const sh = useShareStore.getState();
  const now = Date.now();
  const self = selfEntry();
  const devices = upsertSelf(useSyncStore.getState().devices, self);
  // 回写本机条目，弹窗"最近同步"即时刷新（sync-store 不在自动上传订阅里，不会引发回声）
  useSyncStore.setState({ devices });
  const blob: SyncBlobV3 = {
    v: 3,
    packedAt: now,
    data: {
      watchlist: s.watchlist,
      groups: s.groups,
      profiles: a.profiles,
      currentProfileId: a.currentProfileId,
      history: a.history,
      devices,
      share: {
        code: sh.shareCode,
        token: sh.shareToken,
        displayName: sh.shareDisplayName,
        groupIds: sh.shareGroupIds,
        mode: sh.shareMode,
        expireDays: sh.shareExpireDays,
      },
    },
  };
  return JSON.stringify(blob);
}

/** hash 用净化副本：packedAt 与设备 lastSyncedAt 都属易变字段，不算进 hash，防扰动空传 */
function sanitizeForHash(plain: string): string {
  try {
    const o = JSON.parse(plain);
    o.packedAt = 0;
    if (Array.isArray(o?.data?.devices)) {
      o.data.devices = o.data.devices.map((d: SyncDeviceEntry) => ({ ...d, lastSyncedAt: 0 }));
    }
    return JSON.stringify(o);
  } catch {
    return plain;
  }
}

/** 应用远端快照（响应式 setState + persist 自动落盘；回声抑制见模块头注释；v1/v2/v3 兼容，v1/v2 的标的 groupId 迁移进 groups.stockCodes） */
function applyRemoteBlob(plain: string) {
  let blob: SyncBlobV3;
  try {
    blob = JSON.parse(plain) as SyncBlobV3;
  } catch { return; }
  if ((blob.v !== 1 && blob.v !== 2 && blob.v !== 3) || !blob.data) return;
  const d = blob.data;

  // 被移出检测：远端设备清单明确存在、不含本机、且本机不是刚配对的新设备（lastVersion>0），
  // 说明本机被另一端移除——清身份退出同步，避免本机又把自己写回清单并继续更新数据。
  const remoteDevices = Array.isArray(d.devices) ? (d.devices as SyncDeviceEntry[]) : null;
  const stBefore = useSyncStore.getState();
  const selfInRemote = stBefore.deviceId && remoteDevices
    ? remoteDevices.some((x) => x.id === stBefore.deviceId)
    : true;
  if (remoteDevices && !selfInRemote && stBefore.enabled && stBefore.lastVersion > 0) {
    stBefore.clearIdentity();
    toast.info('你已被移出同步组');
    return;
  }

  applyingRemote = true;
  try {
    // 多组映射规整：default 组已废弃 → 删除；v1/v2 标的的 groupId 收集进对应组 stockCodes（与本地 persist 迁移同口径）
    const groups: WatchlistGroup[] = (Array.isArray(d.groups) ? d.groups : [])
      .filter((g: any) => g.id !== 'default')
      .map((g: any) => {
        const codes: string[] = Array.isArray(g.stockCodes) ? g.stockCodes : [];
        for (const s of Array.isArray(d.watchlist) ? d.watchlist : []) {
          // v1/v2 快照的标的带 groupId（v3 已无此字段），按 any 读取做迁移
          const legacy = s as any;
          if (legacy.groupId === g.id && s.code && !codes.includes(s.code)) codes.push(s.code);
        }
        return { ...g, stockCodes: codes };
      });
    const watchlist: Stock[] = (Array.isArray(d.watchlist) ? d.watchlist : []).map((s: any) => {
      const { groupId, ...rest } = s;
      return rest;
    });
    useStockStore.setState({
      watchlist,
      groups,
    });
    useAiStore.setState({
      profiles: Array.isArray(d.profiles) ? d.profiles : [],
      currentProfileId: typeof d.currentProfileId === 'string' ? d.currentProfileId : '',
      history: Array.isArray(d.history) ? d.history : [],
    });
    // 分享状态（软加字段，旧 blob 无此键 → 不动本地；含撤销传播：对端 clearShare 后这里收到空串）
    if (d.share && typeof d.share === 'object') {
      const sh = d.share;
      useShareStore.setState({
        shareCode: typeof sh.code === 'string' ? sh.code : '',
        shareToken: typeof sh.token === 'string' ? sh.token : '',
        shareDisplayName: typeof sh.displayName === 'string' ? sh.displayName : '',
        shareGroupIds: Array.isArray(sh.groupIds) ? sh.groupIds.filter((x): x is string => typeof x === 'string') : [],
        shareMode: sh.mode === 'auto' ? 'auto' : 'manual',
        shareExpireDays: typeof sh.expireDays === 'number' ? sh.expireDays : null,
      });
    }
    // 设备清单：远端为主，但本机永远可见；共享清单为名字事实源（被它端改名后本地跟随）
    if (Array.isArray(d.devices)) {
      const st = useSyncStore.getState();
      const remote = d.devices as SyncDeviceEntry[];
      const self = st.deviceId ? remote.find((x) => x.id === st.deviceId) : undefined;
      const devices = st.deviceId && !self
        ? upsertSelf(remote, { id: st.deviceId, name: st.deviceName || defaultDeviceName(), lastSyncedAt: 0 })
        : remote;
      useSyncStore.setState({
        devices,
        ...(self?.name ? { deviceName: self.name } : {}),
      });
    }
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
    if (res.status === 404) {
      // 云端快照已被某个设备删除（该设备关闭了同步）→ 本机也退出，不再重新建快照
      useSyncStore.getState().clearIdentity();
      toast.info('云端同步已被关闭');
      return false;
    }
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
    if (res.status === 404) {
      useSyncStore.getState().clearIdentity();
      toast.info('云端同步已被关闭');
      return false;
    }
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
  const hash = await sha256Hex(sanitizeForHash(plain));
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
    const pulled = await pull();
    if (!pulled || !useSyncStore.getState().enabled) {
      // pull 可能因快照不存在/网络失败/被移出而清空身份，不能装作恢复成功
      useSyncStore.getState().clearIdentity();
      return { ok: false, error: '恢复失败，云端快照不可用' };
    }
    // 拉完立即上传注册本机，原设备才能看到新设备
    await upload(true);
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

/** 重命名设备（本机或共享清单里任意一台），改名随下次上传同步到所有端 */
export async function renameDevice(targetId: string, name: string): Promise<void> {
  const st = useSyncStore.getState();
  const trimmed = name.trim();
  if (!trimmed || !st.devices.some((d) => d.id === targetId)) return;
  const devices = st.devices.map((d) => (d.id === targetId ? { ...d, name: trimmed } : d));
  useSyncStore.setState(targetId === st.deviceId ? { devices, deviceName: trimmed } : { devices });
  await upload(true);
}

/** 从共享清单移除一台设备（本机不可移除）。
 *  清单是共享数据，本机移除后会上传一份不含该设备的清单；被移除设备下次联系时会发现自己不在清单里并自动退出同步。
 *  注：这是协作式移除——若有人改本地存储硬加回，仍可绕过；要防那种情况需要密钥轮换（当前未实现）。 */
export async function removeDevice(targetId: string): Promise<void> {
  const st = useSyncStore.getState();
  if (!st.enabled || !st.syncId || targetId === st.deviceId) return;
  const devices = st.devices.filter((d) => d.id !== targetId);
  useSyncStore.setState({ devices });
  await upload(true);
}

/** 引擎初始化（幂等，SyncEngine 组件挂载时调用） */
export function initSyncEngine() {
  if (initialized) return;
  initialized = true;

  // 首启生成本机设备身份（不依赖是否开启云同步）
  useSyncStore.getState().ensureDevice();

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
  useShareStore.subscribe(scheduleUpload); // 开/撤分享、改组改有效期也要随同步走

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
