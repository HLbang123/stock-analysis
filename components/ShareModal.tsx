'use client';

/**
 * 分享弹窗（首页「分享」按钮入口）
 * 两 tab：分享（我的分享面板）/ 订阅（订阅列表 + 只读详情）。
 * 只读详情：分组 tab + 标的列表（实时行情）+ 多选移入自己分组（复用自选多选交互）。
 * 分享快照明文（组名+标的），读免鉴权；写操作由 ownerToken 鉴权（只在分享方本地）。
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Modal } from '@/components/ui/modal';
import { Tabs } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useStockStore } from '@/store';
import { useShareStore } from '@/store/share-store';
import { enableShare, updateShare, disableShare, subscribeShare, refreshShare } from '@/services/share/engine';
import { getRealtimeQuote, parseStockCode } from '@/services/stockApi';
import type { RealtimeQuote } from '@/types';
import { ArrowLeft, RefreshCw, Plus, Check, Trash2, Share2 } from 'lucide-react';

const ALL = 'all';
const EXPIRE_OPTIONS: { label: string; days: number | null }[] = [
  { label: '长期', days: null },
  { label: '7 天', days: 7 },
  { label: '30 天', days: 30 },
];

function fmtTime(ts: number | null | undefined): string {
  if (!ts) return '--';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ShareModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const { groups, addToWatchlist, addGroup } = useStockStore();
  const share = useShareStore();
  const [tab, setTab] = useState<'share' | 'sub'>('share');
  const [busy, setBusy] = useState(false);
  // 分享 tab（未开启时的填写态）
  const [nameInput, setNameInput] = useState('');
  const [pickedGroupIds, setPickedGroupIds] = useState<string[] | null>(null); // null=默认全选
  // 订阅 tab
  const [codeInput, setCodeInput] = useState('');
  const [viewCode, setViewCode] = useState<string | null>(null); // 只读详情视图
  // 详情
  const [detailGroupId, setDetailGroupId] = useState<string>(ALL);
  const [quotes, setQuotes] = useState<Map<string, RealtimeQuote>>(new Map());
  const [busyQuotes, setBusyQuotes] = useState(false);
  const [multiSelect, setMultiSelect] = useState(false);
  const [selectedCodes, setSelectedCodes] = useState<Set<string>>(new Set());
  const [showPicker, setShowPicker] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');

  // 打开即重置视图状态
  useEffect(() => {
    if (open) {
      setTab('share');
      setViewCode(null);
      setMultiSelect(false);
      setSelectedCodes(new Set());
      setNameInput(share.shareDisplayName);
      setPickedGroupIds(null);
      setCodeInput('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const allGroupIds = groups.map((g) => g.id);
  const effectivePicked = pickedGroupIds ?? allGroupIds;

  // ---- 分享 tab ----
  const handleEnable = async () => {
    if (!nameInput.trim()) { toast.error('请填写显示名'); return; }
    if (effectivePicked.length === 0) { toast.error('请先选择要分享的分组'); return; }
    setBusy(true);
    const r = await enableShare(nameInput, effectivePicked);
    setBusy(false);
    if (r.ok) toast.success('分享已开启');
    else toast.error(r.error);
  };

  const handleUpload = async () => {
    setBusy(true);
    const ok = await updateShare();
    setBusy(false);
    if (ok) toast.success('已上传');
    else toast.error('上传失败，请稍后重试');
  };

  const handleDisable = async () => {
    setBusy(true);
    await disableShare();
    setBusy(false);
    toast.success('已撤销分享');
  };

  const togglePicked = (id: string) => {
    setPickedGroupIds((prev) => {
      const cur = prev ?? allGroupIds;
      return cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    });
  };
  const toggleShareGroup = (id: string) => {
    const cur = share.shareGroupIds;
    share.setShareGroupIds(cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
  };

  // ---- 订阅 tab ----
  const handleSubscribe = async () => {
    setBusy(true);
    const r = await subscribeShare(codeInput);
    setBusy(false);
    if (r.ok) {
      toast.success('订阅成功');
      setCodeInput('');
    } else {
      toast.error(r.error);
    }
  };

  const viewSub = viewCode ? share.subscriptions.find((s) => s.code === viewCode) : null;

  // ---- 只读详情 ----
  const detailGroups = viewSub?.snapshot?.groups ?? [];
  const activeGroup = detailGroupId === ALL ? null : detailGroups.find((g) => g.name === detailGroupId);
  const visibleStocks = activeGroup ? activeGroup.stocks : detailGroups.flatMap((g) => g.stocks);

  const loadQuotes = async () => {
    const codes = visibleStocks.map((s) => s.code);
    if (codes.length === 0) { setQuotes(new Map()); return; }
    setBusyQuotes(true);
    const results = await Promise.all(codes.map(async (c) => {
      const q = await getRealtimeQuote(c).catch(() => null);
      return q ? ([c, q] as const) : null;
    }));
    const m = new Map<string, RealtimeQuote>();
    for (const r of results) if (r) m.set(r[0], r[1]);
    setQuotes(m);
    setBusyQuotes(false);
  };

  useEffect(() => {
    if (viewCode) {
      setDetailGroupId(ALL);
      setMultiSelect(false);
      setSelectedCodes(new Set());
      setQuotes(new Map());
      loadQuotes();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewCode]);

  const toggleSelect = (code: string) => {
    setSelectedCodes((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };
  const exitMulti = () => {
    setMultiSelect(false);
    setSelectedCodes(new Set());
  };

  const moveSelected = (groupId?: string) => {
    const stocks = visibleStocks.filter((s) => selectedCodes.has(s.code));
    if (stocks.length === 0) return;
    for (const s of stocks) {
      const parsed = parseStockCode(s.code);
      addToWatchlist(
        { code: s.code, name: s.name, market: parsed.market, pureCode: parsed.pureCode },
        groupId
      );
    }
    toast.success(`已移入 ${stocks.length} 只`);
    setShowPicker(false);
    exitMulti();
  };

  const createGroupAndMove = () => {
    const name = newGroupName.trim();
    if (!name) return;
    if (!addGroup(name)) { toast.error('分组已存在'); return; }
    const g = useStockStore.getState().groups.find((g) => g.name === name);
    setNewGroupName('');
    moveSelected(g?.id);
  };

  return (
    <Modal title="分享" onClose={onClose} variant="center" maxWidth="sm:max-w-md">
      <div className="p-4">
        <Tabs
          items={[
            { value: 'share', label: '分享' },
            { value: 'sub', label: '订阅' },
          ]}
          value={tab}
          onChange={(v) => setTab(v)}
          className="mb-4"
        />

        {viewCode && viewSub ? (
          /* ── 只读详情 ── */
          <div>
            <div className="flex items-center gap-2 mb-3">
              <button
                onClick={() => setViewCode(null)}
                className="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-lg transition"
                title="返回"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white truncate">{viewSub.displayName}</h3>
                <p className="text-xs text-gray-400">更新于 {fmtTime(viewSub.updatedAt)}</p>
              </div>
              <button
                onClick={() => refreshShare(viewSub.code).then((ok) => { if (ok) { loadQuotes(); toast.success('已刷新'); } else toast.error('刷新失败'); })}
                className="p-1.5 text-gray-400 hover:text-[var(--color-accent)] rounded-lg transition"
                title="刷新"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>

            {detailGroups.length === 0 ? (
              <p className="text-center py-10 text-sm text-gray-400">分享内容为空</p>
            ) : (
              <>
                {/* 分组 chips（只读） */}
                <div className="flex gap-1.5 mb-3 overflow-x-auto pb-1">
                  <button
                    onClick={() => setDetailGroupId(ALL)}
                    className={cn(
                      'shrink-0 px-3 py-1 rounded-full text-xs transition',
                      detailGroupId === ALL
                        ? 'bg-[var(--color-accent)] text-white'
                        : 'bg-gray-100 dark:bg-gray-800 text-gray-500'
                    )}
                  >
                    全部 {detailGroups.flatMap((g) => g.stocks).length}
                  </button>
                  {detailGroups.map((g) => (
                    <button
                      key={g.name}
                      onClick={() => setDetailGroupId(g.name)}
                      className={cn(
                        'shrink-0 px-3 py-1 rounded-full text-xs transition',
                        detailGroupId === g.name
                          ? 'bg-[var(--color-accent)] text-white'
                          : 'bg-gray-100 dark:bg-gray-800 text-gray-500'
                      )}
                    >
                      {g.name} {g.stocks.length}
                    </button>
                  ))}
                </div>

                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-gray-400">{activeGroup?.name ?? '全部'} · {visibleStocks.length} 只</span>
                  {multiSelect ? (
                    <button onClick={exitMulti} className="text-xs text-gray-500">完成</button>
                  ) : (
                    <button onClick={() => setMultiSelect(true)} className="text-xs text-[var(--color-accent)]">多选</button>
                  )}
                </div>

                <div className="space-y-1.5 max-h-[45vh] overflow-y-auto">
                  {visibleStocks.map((s) => {
                    const quote = quotes.get(s.code);
                    const name = quote?.name || s.name;
                    return (
                      <div
                        key={s.code}
                        onClick={() => (multiSelect ? toggleSelect(s.code) : (onClose(), router.push(`/stock/${s.code}`)))}
                        className={cn(
                          'flex items-center justify-between px-3 py-2 rounded-lg border border-gray-100 dark:border-gray-800 cursor-pointer transition',
                          multiSelect && selectedCodes.has(s.code) && 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]/40'
                        )}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          {multiSelect && (
                            <span
                              className={cn(
                                'w-5 h-5 rounded border shrink-0 flex items-center justify-center transition',
                                selectedCodes.has(s.code)
                                  ? 'bg-[var(--color-accent)] border-[var(--color-accent)]'
                                  : 'border-gray-300 dark:border-gray-600'
                              )}
                            >
                              {selectedCodes.has(s.code) && <Check className="w-3.5 h-3.5 text-white" />}
                            </span>
                          )}
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">{name}</div>
                            <div className="text-xs text-gray-400">{s.code}</div>
                          </div>
                        </div>
                        {quote && (
                          <div className="text-right shrink-0">
                            <div className={cn('text-sm font-medium', quote.changePercent >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]')}>
                              {quote.price.toFixed(2)}
                            </div>
                            <div className={cn('text-xs', quote.changePercent >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]')}>
                              {quote.changePercent >= 0 ? '+' : ''}{quote.changePercent.toFixed(2)}%
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {multiSelect && (
                  <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-2.5 rounded-full bg-gray-900 dark:bg-white text-white dark:text-gray-900 shadow-lg">
                    <span className="text-sm whitespace-nowrap">已选 {selectedCodes.size} 只</span>
                    <button
                      onClick={() => { if (selectedCodes.size > 0) setShowPicker(true); }}
                      disabled={selectedCodes.size === 0}
                      className="px-3.5 py-1 rounded-full bg-[var(--color-accent)] text-white text-sm font-medium disabled:opacity-40"
                    >
                      移入分组
                    </button>
                    <button onClick={exitMulti} className="text-sm opacity-70">取消</button>
                  </div>
                )}

                {showPicker && (
                  <Modal title="移入分组" onClose={() => setShowPicker(false)} variant="center" maxWidth="sm:max-w-sm">
                    <div className="p-4 space-y-1">
                      <div className="max-h-[50vh] overflow-y-auto space-y-1">
                        <button
                          onClick={() => moveSelected(undefined)}
                          className="w-full text-left px-3 py-2 rounded-lg text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition"
                        >
                          未分组
                        </button>
                        {groups.map((g) => (
                          <button
                            key={g.id}
                            onClick={() => moveSelected(g.id)}
                            className="w-full text-left px-3 py-2 rounded-lg text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition"
                          >
                            {g.name}（{g.stockCodes.length}）
                          </button>
                        ))}
                      </div>
                      <div className="flex gap-2 pt-2 border-t border-gray-100 dark:border-gray-800">
                        <Input
                          value={newGroupName}
                          onChange={(e) => setNewGroupName(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') createGroupAndMove(); }}
                          placeholder="新建分组"
                          maxLength={12}
                          className="flex-1"
                        />
                        <button onClick={createGroupAndMove} className="px-3 py-2 rounded-lg text-sm bg-[var(--color-accent)] text-white">
                          确定
                        </button>
                      </div>
                    </div>
                  </Modal>
                )}
              </>
            )}
          </div>
        ) : tab === 'share' ? (
          /* ── 我的分享 ── */
          share.shareCode ? (
            <div className="space-y-4">
              <div className="text-center py-2">
                <p className="text-xs text-gray-400 mb-1.5">分享码（发给对方在「订阅」里输入）</p>
                <div className="text-3xl font-bold tracking-[0.3em] text-gray-900 dark:text-white font-mono">
                  {share.shareCode.slice(0, 3)} {share.shareCode.slice(3)}
                </div>
              </div>

              <div>
                <p className="text-xs text-gray-400 mb-1.5">显示名</p>
                <Input
                  value={share.shareDisplayName}
                  onChange={(e) => share.setShareDisplayName(e.target.value)}
                  maxLength={20}
                  placeholder="我的自选"
                />
              </div>

              <div>
                <p className="text-xs text-gray-400 mb-1.5">分享的分组</p>
                <div className="space-y-1">
                  {groups.map((g) => (
                    <label key={g.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer text-sm">
                      <input
                        type="checkbox"
                        checked={share.shareGroupIds.includes(g.id)}
                        onChange={() => toggleShareGroup(g.id)}
                        className="accent-[var(--color-accent)]"
                      />
                      <span className="flex-1 text-gray-700 dark:text-gray-300">{g.name}</span>
                      <span className="text-xs text-gray-400">{g.stockCodes.length} 只</span>
                    </label>
                  ))}
                </div>
                {groups.length === 0 && <p className="text-xs text-gray-400 text-center py-2">还没有分组</p>}
              </div>

              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-400">上传方式</span>
                <div className="flex gap-1">
                  {(['manual', 'auto'] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => share.setShareMode(m)}
                      className={cn(
                        'px-2.5 py-1 rounded-lg text-xs transition',
                        share.shareMode === m
                          ? 'bg-[var(--color-accent)] text-white'
                          : 'bg-gray-100 dark:bg-gray-800 text-gray-500'
                      )}
                    >
                      {m === 'manual' ? '手动上传' : '自动上传'}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-400">有效期</span>
                <div className="flex gap-1">
                  {EXPIRE_OPTIONS.map((o) => (
                    <button
                      key={o.label}
                      onClick={() => share.setShareExpireDays(o.days)}
                      className={cn(
                        'px-2.5 py-1 rounded-lg text-xs transition',
                        share.shareExpireDays === o.days
                          ? 'bg-[var(--color-accent)] text-white'
                          : 'bg-gray-100 dark:bg-gray-800 text-gray-500'
                      )}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>

              <button
                onClick={handleUpload}
                disabled={busy}
                className="w-full py-2.5 rounded-lg text-sm font-medium bg-[var(--color-accent)] text-white hover:opacity-90 disabled:opacity-50"
              >
                {busy ? '上传中...' : share.shareMode === 'manual' ? '上传分享' : '立即上传'}
              </button>
              {share.shareMode === 'auto' && (
                <p className="text-xs text-gray-400 text-center">已开启自动上传，分组改动后自动同步</p>
              )}
              <button
                onClick={handleDisable}
                disabled={busy}
                className="w-full py-1.5 text-xs text-gray-400 hover:text-[var(--color-danger)] transition"
              >
                撤销分享
              </button>
            </div>
          ) : (
            /* 未开启 */
            <div className="space-y-4">
              <div>
                <p className="text-xs text-gray-400 mb-1.5">显示名（对方看到的名字）</p>
                <Input
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  maxLength={20}
                  placeholder="如：老王的自选"
                />
              </div>
              <div>
                <p className="text-xs text-gray-400 mb-1.5">要分享的分组</p>
                {groups.length === 0 ? (
                  <p className="text-xs text-gray-400 text-center py-2">还没有分组，先在自选里建一个</p>
                ) : (
                  <div className="space-y-1">
                    {groups.map((g) => (
                      <label key={g.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer text-sm">
                        <input
                          type="checkbox"
                          checked={effectivePicked.includes(g.id)}
                          onChange={() => togglePicked(g.id)}
                          className="accent-[var(--color-accent)]"
                        />
                        <span className="flex-1 text-gray-700 dark:text-gray-300">{g.name}</span>
                        <span className="text-xs text-gray-400">{g.stockCodes.length} 只</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
              <button
                onClick={handleEnable}
                disabled={busy}
                className="w-full py-2.5 rounded-lg text-sm font-medium bg-[var(--color-accent)] text-white hover:opacity-90 disabled:opacity-50"
              >
                {busy ? '开启中...' : '开启分享'}
              </button>
            </div>
          )
        ) : (
          /* ── 我订阅的 ── */
          <div className="space-y-3">
            <div className="flex gap-2">
              <Input
                value={codeInput}
                onChange={(e) => setCodeInput(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="6 位数字分享码"
                inputMode="numeric"
                className="flex-1 text-center tracking-[0.3em] font-mono"
                onKeyDown={(e) => { if (e.key === 'Enter') handleSubscribe(); }}
              />
              <button
                onClick={handleSubscribe}
                disabled={busy}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-50"
              >
                订阅
              </button>
            </div>

            {share.subscriptions.length === 0 ? (
              <div className="text-center py-10 text-gray-400">
                <Share2 className="w-10 h-10 mx-auto mb-2 opacity-30" />
                <p className="text-sm">输入对方的分享码即可订阅</p>
              </div>
            ) : (
              <div className="space-y-1.5">
                {share.subscriptions.map((s) => (
                  <div
                    key={s.code}
                    className="flex items-center justify-between px-3 py-2 rounded-lg border border-gray-100 dark:border-gray-800"
                  >
                    <button
                      onClick={() => setViewCode(s.code)}
                      className="flex-1 text-left min-w-0"
                    >
                      <div className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">
                        {s.displayName}
                        <span className="ml-2 text-xs text-gray-400 font-normal">{s.code}</span>
                      </div>
                      <div className="text-xs text-gray-400">
                        {s.snapshot?.groups.length ?? 0} 组 · 更新于 {fmtTime(s.updatedAt)}
                      </div>
                    </button>
                    <button
                      onClick={() => share.removeSubscription(s.code)}
                      className="p-1.5 text-gray-400 hover:text-[var(--color-danger)] rounded-lg transition shrink-0"
                      title="退订"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
