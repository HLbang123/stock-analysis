'use client';

/**
 * 云同步弹窗（首页「同步」按钮入口）
 * 三态：未开启（开启云同步 / 输入配对码恢复）→ 已开启（自动同步开关/添加设备/立即同步/关闭同步）
 * 配对码即微信输入法式：短码只做配对瞬间凭证，10 分钟倒计时，一次性。
 * 无表情、无确认按钮、无二维码（用户拍板的简化）。
 */

import { useEffect, useState } from 'react';
import { Modal } from '@/components/ui/modal';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useSyncStore, type SyncDeviceEntry } from '@/store/sync-store';
import { enableCloud, redeemPairCode, createPairCode, disableCloud, upload, pull, renameDevice, removeDevice } from '@/services/sync/engine';
import { isValidPairCode } from '@/lib/sync-crypto';

function fmtTime(ts: number | null): string {
  if (!ts) return '--';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 设备最近同步相对时间（弹窗内打开时计算，足够用） */
function fmtRecent(ts: number): string {
  if (!ts) return '尚未同步';
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  return fmtTime(ts);
}

export function SyncModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { enabled, autoSync, lastSyncAt, lastError, devices, deviceId, deviceName } = useSyncStore();
  const [busy, setBusy] = useState(false);
  const [redeemInput, setRedeemInput] = useState('');
  // 配对码展示态
  const [pair, setPair] = useState<{ code: string; expiresAt: number } | null>(null);
  const [remainSec, setRemainSec] = useState(0);
  // 设备行内改名
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [busyRefresh, setBusyRefresh] = useState(false);

  // 配对码倒计时
  useEffect(() => {
    if (!pair) return;
    const tick = () => {
      const left = Math.max(0, Math.floor((pair.expiresAt - Date.now()) / 1000));
      setRemainSec(left);
      if (left === 0) setPair(null);
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [pair]);

  // 打开即读一下上次错误（自动同步失败静默，这里亮出来）
  useEffect(() => {
    if (open) setRedeemInput('');
  }, [open]);

  if (!open) return null;

  const startEnable = async () => {
    setBusy(true);
    const ok = await enableCloud();
    setBusy(false);
    if (ok) toast.success('云同步已开启');
    else toast.error('开启失败，请稍后重试');
  };

  const startPair = async () => {
    setBusy(true);
    const r = await createPairCode();
    setBusy(false);
    if ('code' in r) setPair(r);
    else toast.error(r.error);
  };

  const doRedeem = async () => {
    const clean = redeemInput.replace(/\s/g, '');
    if (!isValidPairCode(clean)) {
      toast.error('请输入 6 位数字配对码');
      return;
    }
    setBusy(true);
    const r = await redeemPairCode(clean);
    setBusy(false);
    if (r.ok) toast.success('已恢复，数据同步中');
    else toast.error(r.error || '配对失败');
  };

  const doManualSync = async () => {
    setBusy(true);
    const r = await upload(true);
    setBusy(false);
    if (r === 'ok') toast.success('已同步');
    else if (r === 'conflict') toast.info('已拉取另一设备的更新');
    else toast.error('同步失败，请稍后重试');
  };

  const doDisable = async () => {
    setBusy(true);
    await disableCloud();
    setBusy(false);
    setPair(null);
    toast.success('已关闭云同步，本地数据保留');
  };

  const doRefresh = async () => {
    setBusyRefresh(true);
    await pull();
    setBusyRefresh(false);
  };

  const startRename = (d: SyncDeviceEntry) => {
    setEditingId(d.id);
    setEditName(d.name);
  };

  const saveRename = async () => {
    if (!editingId) return;
    const id = editingId;
    setEditingId(null);
    if (!editName.trim()) return;
    await renameDevice(id, editName);
  };

  const doRemove = async (d: SyncDeviceEntry) => {
    await removeDevice(d.id);
    toast.success('已移除');
  };

  // 设备清单兜底：开启后还没上传过（devices 为空）时，至少展示本机
  const displayDevices: SyncDeviceEntry[] = devices.length
    ? devices
    : deviceId
      ? [{ id: deviceId, name: deviceName || '本机', lastSyncedAt: lastSyncAt || 0 }]
      : [];

  return (
    <Modal title="云同步" onClose={onClose} variant="center" maxWidth="sm:max-w-md">
      <div className="p-5 space-y-4">
        {!enabled ? (
          <>
            {/* 未开启：开启与恢复并重，防换机用户误点开启生成新身份 */}
            <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed">
              自选、分组、AI 配置、分析历史加密备份到云端，换设备输入配对码即可恢复。
            </p>
            <button
              onClick={startEnable}
              disabled={busy}
              className="w-full py-2.5 bg-[var(--color-accent)] text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50"
            >
              {busy ? '开启中...' : '开启云同步'}
            </button>

            <div className="flex items-center gap-2 text-xs text-gray-400">
              <span className="h-px flex-1 bg-gray-100 dark:bg-gray-800" />
              已有配对码？
              <span className="h-px flex-1 bg-gray-100 dark:bg-gray-800" />
            </div>
            <div className="flex gap-2">
              <input
                value={redeemInput}
                onChange={(e) => setRedeemInput(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="6 位数字"
                inputMode="numeric"
                className="flex-1 px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent text-sm text-center tracking-[0.4em] font-mono"
              />
              <button
                onClick={doRedeem}
                disabled={busy}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-50"
              >
                恢复
              </button>
            </div>
          </>
        ) : pair ? (
          /* 添加设备：6 位配对码 + 倒计时 */
          <div className="text-center space-y-3 py-2">
            <p className="text-sm text-gray-500">在新设备「云同步」里输入此配对码</p>
            <div className="text-4xl font-bold tracking-[0.35em] text-gray-900 dark:text-white font-mono">
              {pair.code.slice(0, 3)} {pair.code.slice(3)}
            </div>
            <p className={cn('text-xs', remainSec > 0 ? 'text-gray-400' : 'text-[var(--color-danger)]')}>
              {remainSec > 0 ? `剩余 ${Math.floor(remainSec / 60)}:${String(remainSec % 60).padStart(2, '0')}，用一次即失效` : '已过期'}
            </p>
            <button onClick={() => setPair(null)} className="text-xs text-[var(--color-accent)] hover:underline">
              完成
            </button>
          </div>
        ) : (
          <>
            {/* 已开启 */}
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-500">上次同步</span>
              <span className="font-medium text-gray-900 dark:text-white">{fmtTime(lastSyncAt)}</span>
            </div>
            {lastError && <p className="text-xs text-[var(--color-warning)]">{lastError}</p>}

            {/* 已连接设备：共享清单随快照同步，点名字可改名，本机置顶标识 */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm text-gray-500">已连接设备（{displayDevices.length}）</span>
                <button
                  onClick={doRefresh}
                  disabled={busyRefresh}
                  className="text-xs text-[var(--color-accent)] hover:underline disabled:opacity-50"
                >
                  {busyRefresh ? '刷新中...' : '刷新'}
                </button>
              </div>
              <div className="rounded-lg border border-gray-100 dark:border-gray-800 overflow-hidden">
                {displayDevices.map((d) => (
                  <div
                    key={d.id}
                    className={cn(
                      'flex items-center justify-between px-3 py-2',
                      d.id === deviceId && 'bg-gray-50 dark:bg-gray-800/40'
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      {editingId === d.id ? (
                        <input
                          value={editName}
                          autoFocus
                          maxLength={20}
                          onChange={(e) => setEditName(e.target.value)}
                          onBlur={saveRename}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveRename();
                            if (e.key === 'Escape') setEditingId(null);
                          }}
                          className="w-full px-1.5 py-0.5 rounded border border-gray-200 dark:border-gray-700 bg-transparent text-sm text-gray-800 dark:text-gray-200"
                        />
                      ) : (
                        <button
                          onClick={() => startRename(d)}
                          className="flex items-center gap-1.5 text-sm font-medium text-gray-800 dark:text-gray-200 hover:text-[var(--color-accent)]"
                        >
                          <span className="truncate">{d.name || '未命名设备'}</span>
                          {d.id === deviceId && (
                            <span className="text-[10px] px-1 py-px rounded bg-[var(--color-accent)]/10 text-[var(--color-accent)]">
                              本机
                            </span>
                          )}
                        </button>
                      )}
                      <p className="text-xs text-gray-400 mt-0.5">最近同步 · {fmtRecent(d.lastSyncedAt)}</p>
                    </div>
                    {d.id !== deviceId && editingId !== d.id && (
                      <button
                        onClick={() => doRemove(d)}
                        title="移除后若该设备继续使用会重新出现"
                        className="ml-2 shrink-0 text-xs text-gray-400 hover:text-[var(--color-danger)]"
                      >
                        移除
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between rounded-lg px-3 py-2 bg-gray-50 dark:bg-gray-800/40">
              <div>
                <div className="text-sm font-medium text-gray-800 dark:text-gray-200">自动同步</div>
                <div className="text-xs text-gray-400">改动后自动上传，页面开着时定时检查更新</div>
              </div>
              <button
                onClick={() => useSyncStore.getState().setAutoSync(!autoSync)}
                className={cn(
                  'relative rounded-full transition-colors',
                  autoSync ? 'bg-[var(--color-accent)]' : 'bg-gray-300 dark:bg-gray-600'
                )}
                style={{ width: 40, height: 22 }}
                aria-label="自动同步"
              >
                <span
                  className={cn(
                    'absolute top-0.5 bg-white rounded-full shadow transition-all',
                    autoSync ? 'right-0.5' : 'left-0.5'
                  )}
                  style={{ width: 18, height: 18 }}
                />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={startPair}
                disabled={busy}
                className="py-2.5 rounded-lg text-sm font-medium bg-[var(--color-accent)] text-white hover:opacity-90 disabled:opacity-50"
              >
                添加设备
              </button>
              <button
                onClick={doManualSync}
                disabled={busy}
                className="py-2.5 rounded-lg text-sm font-medium bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-50"
              >
                {busy ? '同步中...' : '立即同步'}
              </button>
            </div>
            <button
              onClick={doDisable}
              disabled={busy}
              className="w-full py-1.5 text-xs text-gray-400 hover:text-[var(--color-danger)] transition"
            >
              关闭云同步（本地数据保留，云端快照删除）
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
