'use client';

/**
 * 自选分享逻辑层
 * - 分享方：enableShare 生成码+ownerToken → updateShare 手动上传 → 自动模式监听自选变化 debounce 上传 → disableShare 撤销
 * - 订阅方：subscribeShare 输码拉取缓存 → refreshShare 刷新
 * - 只读天然成立：服务器读取免鉴权、写需 ownerToken（只在分享方本地）
 */

import { useStockStore } from '@/store';
import { useShareStore, type ShareSnapshotData } from '@/store/share-store';
import { useSyncStore } from '@/store/sync-store';
import { checkAndPull } from '@/services/sync/engine';

const CODE_RE = /^\d{6}$/;

/** 生成 ownerToken（16B 随机 hex，写凭证） */
function genToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** 从 store 打包分享快照（只含选中分组：组名 + 标的代码/名称；带数量校验防空组） */
export function packShareSnapshot(groupIds: string[]): ShareSnapshotData | null {
  const { groups, watchlist } = useStockStore.getState();
  const nameOf = (code: string) => watchlist.find((s) => s.code === code)?.name ?? code;
  const selected = groups
    .filter((g) => groupIds.includes(g.id) && g.stockCodes.length > 0)
    .map((g) => ({
      name: g.name,
      stocks: g.stockCodes.map((code) => ({ code, name: nameOf(code) })),
    }));
  return selected.length > 0 ? { groups: selected } : null;
}

function expireAtMs(): number | undefined {
  const days = useShareStore.getState().shareExpireDays;
  return days ? Date.now() + days * 86_400_000 : undefined;
}

/** 首启分享：生成码+token → 创建 → 存本地 */
export async function enableShare(
  displayName: string,
  groupIds: string[]
): Promise<{ ok: boolean; error?: string }> {
  const snapshot = packShareSnapshot(groupIds);
  if (!snapshot) return { ok: false, error: '请先选择要分享的分组' };
  const token = genToken();
  try {
    const res = await fetch('/api/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ownerToken: token,
        displayName: displayName.trim() || '我的自选',
        snapshot: JSON.stringify(snapshot),
        expiresAt: expireAtMs(),
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.code) return { ok: false, error: data.error || '开启失败，请稍后重试' };
    useShareStore.getState().setShare(data.code, token, displayName.trim() || '我的自选', groupIds);
    lastShareHash = JSON.stringify(snapshot);
    return { ok: true };
  } catch {
    return { ok: false, error: '开启失败，请稍后重试' };
  }
}

/** 手动上传当前分享（改名/改组/改有效期后调用） */
export async function updateShare(): Promise<boolean> {
  const st = useShareStore.getState();
  if (!st.shareCode || !st.shareToken) return false;
  const snapshot = packShareSnapshot(st.shareGroupIds);
  if (!snapshot) return false;
  try {
    const res = await fetch('/api/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: st.shareCode,
        ownerToken: st.shareToken,
        displayName: st.shareDisplayName.trim() || '我的自选',
        snapshot: JSON.stringify(snapshot),
        expiresAt: expireAtMs(),
      }),
    });
    if (!res.ok) return false;
    lastShareHash = JSON.stringify(snapshot);
    return true;
  } catch {
    return false;
  }
}

/** 撤销分享：删服务器快照 + 清本地分享状态（订阅方不受影响，只读视图保留最后一次快照） */
export async function disableShare(): Promise<void> {
  const st = useShareStore.getState();
  if (st.shareCode && st.shareToken) {
    try {
      await fetch('/api/share', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: st.shareCode, ownerToken: st.shareToken }),
      });
    } catch { /* 删除失败不阻断本地关闭 */ }
  }
  useShareStore.getState().clearShare();
  lastShareHash = '';
}

/** 本机订阅者标识：复用同步引擎的设备 ID（全站挂载时已生成，随机 12 hex，无身份信息） */
function subscriberId(): string {
  useSyncStore.getState().ensureDevice();
  return useSyncStore.getState().deviceId;
}

/** 订阅：输码拉取并缓存（带设备 ID 上报，供分享方看订阅人数） */
export async function subscribeShare(code: string): Promise<{ ok: boolean; error?: string }> {
  const clean = code.replace(/\s/g, '');
  if (!CODE_RE.test(clean)) return { ok: false, error: '请输入 6 位数字分享码' };
  try {
    const res = await fetch(`/api/share?code=${clean}&sid=${subscriberId()}`);
    const data = await res.json().catch(() => ({}));
    if (res.status === 404) return { ok: false, error: data.error || '分享码无效或已过期' };
    if (!res.ok) return { ok: false, error: '拉取失败，请稍后重试' };
    let snapshot: ShareSnapshotData;
    try {
      snapshot = JSON.parse(data.snapshot);
    } catch {
      return { ok: false, error: '数据异常，请稍后重试' };
    }
    useShareStore.getState().upsertSubscription({
      code: clean,
      displayName: data.displayName,
      snapshot,
      fetchedAt: Date.now(),
      updatedAt: data.updatedAt,
    });
    return { ok: true };
  } catch {
    return { ok: false, error: '拉取失败，请稍后重试' };
  }
}

/** 刷新订阅（失败保留旧快照；404=对方已撤销/过期 → 打 dead 标，列表灰显；带设备 ID 刷新活跃时间） */
export async function refreshShare(code: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/share?code=${code}&sid=${subscriberId()}`);
    if (res.status === 404) {
      useShareStore.getState().markSubscriptionDead(code);
      return false;
    }
    if (!res.ok) return false;
    const data = await res.json();
    let snapshot: ShareSnapshotData;
    try {
      snapshot = JSON.parse(data.snapshot);
    } catch {
      return false;
    }
    useShareStore.getState().upsertSubscription({
      code,
      displayName: data.displayName,
      snapshot,
      fetchedAt: Date.now(),
      updatedAt: data.updatedAt,
    });
    return true;
  } catch {
    return false;
  }
}

/** 退订：删服务器订阅登记（分享方人数-1）+ 移除本地订阅 */
export async function unsubscribeShare(code: string): Promise<void> {
  try {
    await fetch('/api/share', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, sid: subscriberId() }),
    });
  } catch { /* 登记删除失败不阻断本地退订 */ }
  useShareStore.getState().removeSubscription(code);
}

/** 分享方查询自己分享的订阅人数（ownerToken 鉴权） */
export async function fetchSubscriberCount(): Promise<number | null> {
  const st = useShareStore.getState();
  if (!st.shareCode || !st.shareToken) return null;
  try {
    const res = await fetch(`/api/share?code=${st.shareCode}&ownerToken=${st.shareToken}`);
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.subscriberCount === 'number' ? data.subscriberCount : null;
  } catch {
    return null;
  }
}

// ---- 自动上传（shareMode='auto' 时监听自选变化 debounce 15s 推）----
let shareUploadTimer: ReturnType<typeof setTimeout> | null = null;
let lastShareHash = '';
let shareAutoInit = false;

export function initShareAutoSync() {
  if (shareAutoInit) return;
  shareAutoInit = true;

  const schedule = () => {
    const st = useShareStore.getState();
    if (!st.shareCode || st.shareMode !== 'auto') return;
    if (shareUploadTimer) clearTimeout(shareUploadTimer);
    shareUploadTimer = setTimeout(async () => {
      shareUploadTimer = null;
      // 先对齐云端再打包：陈旧设备/后台标签页直接拿本地旧分组上传，
      // 会把已删标的发布成「幽灵股票」（接收方看到不存在的票、刷新又好的根因）——
      // 分享 API 无版本闸（后写必赢），不像同步引擎有 baseVersion 409 兜底
      await checkAndPull();
      const s = useShareStore.getState();
      const snapshot = packShareSnapshot(s.shareGroupIds);
      if (!snapshot) return;
      const plain = JSON.stringify(snapshot);
      if (plain === lastShareHash) return; // 内容没变跳过
      updateShare();
    }, 15_000);
  };

  // 只在 watchlist/groups 引用变化时调度（原订阅对整个 store 开火：
  // 预警扫描 addAlerts 等高频写入会让挂着不动的旧标签页反复把陈旧分组发上分享）
  let prevWatchlist = useStockStore.getState().watchlist;
  let prevGroups = useStockStore.getState().groups;
  useStockStore.subscribe((s) => {
    if (s.watchlist === prevWatchlist && s.groups === prevGroups) return;
    prevWatchlist = s.watchlist;
    prevGroups = s.groups;
    schedule();
  });
}
