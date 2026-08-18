'use client';

import { useEffect, useState, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useStockStore } from '@/store';
import { useUiStore } from '@/store/ui-store';
import { getKLineSina, getBatchQuotes, getBatchKLines } from '@/services/stockApi';
import { isETF } from '@/lib/identify';
import { computeMaCross, type MaCrossState } from '@/lib/stock-helpers';
import { RealtimeQuote } from '@/types';
import { formatPrice, formatChange, cn } from '@/lib/utils';
import { Plus, Trash2, TrendingUp, Check, FolderInput, Menu } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { AddStockPanel } from '@/components/AddStockPanel';
import { GroupBar, ALL_GROUP_ID } from '@/components/GroupBar';
import { GroupManageModal } from '@/components/GroupManageModal';
import { MoveToGroupMenu } from '@/components/MoveToGroupMenu';

export default function WatchlistPage() {
  const router = useRouter();
  const { watchlist, groups, removeFromWatchlist, toggleStockGroup, removeStocks, moveStocksToGroup, reorderStocks } = useStockStore();
  const [stockQuotes, setStockQuotes] = useState<Map<string, RealtimeQuote>>(new Map());
  // MA5/13 交叉状态徽标（金叉/死叉/即将金叉），随行情刷新一起算
  const [crossMap, setCrossMap] = useState<Map<string, MaCrossState>>(new Map());
  // RPS60 徽标（DB rps_scores，随行情刷新一起批量拉）
  const [rpsMap, setRpsMap] = useState<Record<string, { rps60: number | null; calcDate: string }>>({});

  // 分组状态（位置存 ui-store：钻详情返回后仍在原分组）
  const selectedGroupId = useUiStore(s => s.watchlistGroupId);
  const setSelectedGroupId = useUiStore(s => s.setWatchlistGroupId);
  const [showGroupManage, setShowGroupManage] = useState(false);
  const [moveMenuFor, setMoveMenuFor] = useState<string | null>(null);

  // 多选删除状态
  const [multiSelect, setMultiSelect] = useState(false);
  const [selectedCodes, setSelectedCodes] = useState<Set<string>>(new Set());
  // 多选移动分组弹窗
  const [showBatchMove, setShowBatchMove] = useState(false);
  // 组内添加弹窗（底部「添加标的到本组」入口）
  const [showGroupAdd, setShowGroupAdd] = useState(false);
  // 长按进入多选：fired 用于吞掉长按松手后的那次 click（防刚进入就被反选/跳转）
  const longPressRef = useRef<{ timer: ReturnType<typeof setTimeout> | null; fired: boolean }>({ timer: null, fired: false });
  const startLongPress = (code: string) => {
    if (multiSelect) return;
    cancelLongPress();
    longPressRef.current.timer = setTimeout(() => {
      longPressRef.current.fired = true;
      setMultiSelect(true);
      setSelectedCodes(new Set([code]));
    }, 500);
  };
  const cancelLongPress = () => {
    if (longPressRef.current.timer) {
      clearTimeout(longPressRef.current.timer);
      longPressRef.current.timer = null;
    }
  };

  // 拖动排序（多选模式内，手柄触发）：拖动中只动本地 dragOrder，松手一次性提交 store。
  // 事件挂 window + rAF 每帧驱动：不依赖 pointer capture 的 React 事件重定向（iOS 上拖动中 DOM 重排
  // 会掐断 capture 事件流，曾表现为拖到一半卡死）；插入位按行中线判定，不用 elementFromPoint
  // （指针落进行间隙或覆盖层时它返回容器，丢目标）。
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const [dragInfo, setDragInfo] = useState<{ code: string; offsetY: number } | null>(null);
  const dragRef = useRef<{ code: string; startY: number; startScroll: number; lastOffset: number } | null>(null);
  // dragOrder 的同步镜像：重排判定须以 ref 为准（state 可能还是上一帧的）
  const dragOrderRef = useRef<string[] | null>(null);
  const dragPosRef = useRef(0); // 最近一次指针 clientY，rAF 每帧读
  const dragCleanupRef = useRef<(() => void) | null>(null);

  /** 按指针位置重排 + 更新被拖卡片位移（pointermove 与 rAF 共用） */
  const applyDrag = (clientY: number) => {
    const d = dragRef.current;
    const order = dragOrderRef.current;
    if (!d || !order) return;
    const from = order.indexOf(d.code);
    // 插入位 = 首张「中线在指针下方」的卡片的槽位（换算成移除被拖卡后的下标；都没越线=排末尾）
    let to = order.length - 1;
    for (let i = 0; i < order.length; i++) {
      if (order[i] === d.code) continue;
      const r = document.querySelector(`[data-stock-code="${order[i]}"]`)?.getBoundingClientRect();
      if (r && clientY < r.top + r.height / 2) { to = i > from ? i - 1 : i; break; }
    }
    if (from >= 0 && to !== from) {
      // 换位后被拖卡片的布局位置平移了，须同步平移 startY 抵消，否则 translateY 与布局位移叠加跳行。
      // 补偿量 = 被跨过卡片的真实高度之和（卡片高度不一：徽章换行/"加载中"单行等），
      // 用被拖卡片自身高度×行数会累积误差 → 视觉位置与指针错开 → 两格间来回换锁死。
      const GAP = 8; // space-y-2
      const step = to > from ? 1 : -1;
      let shift = 0;
      for (let i = from + step; step > 0 ? i <= to : i >= to; i += step) {
        shift += step * (GAP + (document.querySelector(`[data-stock-code="${order[i]}"]`)?.getBoundingClientRect().height ?? 0));
      }
      d.startY += shift;
      const next = [...order];
      next.splice(from, 1);
      next.splice(to, 0, d.code);
      dragOrderRef.current = next;
      setDragOrder(next);
    }
    // 页面滚动也要计入位移（边缘自动滚动时指针不动但内容在动）
    const offsetY = (clientY - d.startY) + (window.scrollY - d.startScroll);
    if (offsetY !== d.lastOffset) {
      d.lastOffset = offsetY;
      setDragInfo({ code: d.code, offsetY });
    }
  };

  const handleGripDown = (e: ReactPointerEvent<HTMLButtonElement>, code: string) => {
    e.preventDefault();
    e.stopPropagation();
    dragCleanupRef.current?.(); // 上次未正常收尾（极端情况）先清掉
    // 保留 pointer capture：松手在窗口外也能收到 pointerup；move/up 走 window 监听双保险
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 指针已失效时忽略 */ }
    dragRef.current = { code, startY: e.clientY, startScroll: window.scrollY, lastOffset: 0 };
    dragPosRef.current = e.clientY;
    dragOrderRef.current = visibleWatchlist.map(s => s.code);
    setDragOrder(dragOrderRef.current);
    setDragInfo({ code, offsetY: 0 });

    let raf = 0;
    const tick = () => {
      if (!dragRef.current) return;
      // 指针贴近视口上下沿时自动滚动页面，长列表才能拖出屏幕外
      const y = dragPosRef.current;
      const EDGE = 72;
      if (y < EDGE) window.scrollBy(0, -(EDGE - y) / 6);
      else if (y > window.innerHeight - EDGE) window.scrollBy(0, (y - (window.innerHeight - EDGE)) / 6);
      applyDrag(y);
      raf = requestAnimationFrame(tick);
    };
    const onMove = (ev: PointerEvent) => { dragPosRef.current = ev.clientY; };
    const onUp = () => {
      cleanup();
      if (dragOrderRef.current) {
        reorderStocks(dragOrderRef.current, selectedGroupId === ALL_GROUP_ID ? undefined : selectedGroupId);
      }
      dragRef.current = null;
      dragOrderRef.current = null;
      setDragOrder(null);
      setDragInfo(null);
    };
    const cleanup = () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      dragCleanupRef.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    dragCleanupRef.current = cleanup;
    raf = requestAnimationFrame(tick);
  };

  // 卸载兜底：清掉 window 监听与 rAF
  useEffect(() => () => dragCleanupRef.current?.(), []);

  // 刷新自选股行情（批量：400+ 自选 = 1 次行情 + 1 次日K 请求）；顺带算 MA5/13 交叉徽标
  const refreshQuotes = async () => {
    const codes = watchlist.map(s => s.code);
    const quotes = await getBatchQuotes(codes);
    setStockQuotes(quotes);

    // 批量拉 RPS60（DB 数据，一次请求全自选）
    if (watchlist.length > 0) {
      try {
        const res = await fetch(`/api/rps/batch?codes=${encodeURIComponent(watchlist.map(s => s.code).join(','))}`);
        if (res.ok) {
          const data = await res.json();
          setRpsMap(data.rps ?? {});
        }
      } catch { /* RPS 失败不影响行情展示 */ }
    } else {
      setRpsMap({});
    }

    // 日K批量（daily_bars 出数）；DB 未覆盖的品种（ETF 等）逐只回落上游
    const klineMap = await getBatchKLines(codes, 20);
    const missing = codes.filter(c => !(klineMap.get(c)?.length));
    if (missing.length > 0) {
      const fallback = await Promise.all(
        missing.map(async c => {
          try {
            const k = await getKLineSina(c, 240, 20);
            return k.length > 0 ? ([c, k] as const) : null;
          } catch {
            return null;
          }
        })
      );
      for (const r of fallback) if (r) klineMap.set(r[0], r[1]);
    }

    const cm = new Map<string, MaCrossState>();
    for (const stock of watchlist) {
      const quote = quotes.get(stock.code);
      const kLines = klineMap.get(stock.code);
      if (!quote || !kLines?.length) continue;
      const state = computeMaCross([...kLines.map(k => k.close), quote.price]);
      if (state) cm.set(stock.code, state);
    }
    setCrossMap(cm);
  };

  // 只在标的「增删」时重拉行情；position 占比、groupId 分组归属、排序变化不触发
  // （排序后与排序前代码集合相同，故 key 排序后拼接，与顺序解耦）
  const watchlistCodesKey = watchlist.map(s => s.code).sort().join(',');
  useEffect(() => {
    refreshQuotes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchlistCodesKey]);

  // 分组派生：切换组只过滤展示，不重拉行情（多组映射：组内标的 = group.stockCodes，顺序即组内排序）
  const activeGroupName = selectedGroupId === ALL_GROUP_ID
    ? '全部'
    : groups.find(g => g.id === selectedGroupId)?.name ?? '全部';
  const selectedGroupCodes = selectedGroupId === ALL_GROUP_ID
    ? null
    : groups.find(g => g.id === selectedGroupId)?.stockCodes;
  const visibleWatchlist = selectedGroupId === ALL_GROUP_ID
    ? watchlist
    : (selectedGroupCodes ?? [])
        .map(c => watchlist.find(s => s.code === c))
        .filter((s): s is NonNullable<typeof s> => !!s);

  // 选中组被删除时自动回退「全部」；切组时退出多选态
  useEffect(() => {
    if (selectedGroupId !== ALL_GROUP_ID && !groups.some(g => g.id === selectedGroupId)) {
      setSelectedGroupId(ALL_GROUP_ID);
    }
  }, [groups, selectedGroupId]);
  useEffect(() => {
    setSelectedCodes(new Set());
    setMultiSelect(false);
  }, [selectedGroupId]);

  // 多选删除
  const toggleSelect = (code: string) => {
    setSelectedCodes(prev => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code); else next.add(code);
      return next;
    });
  };
  const exitMultiSelect = () => {
    setMultiSelect(false);
    setSelectedCodes(new Set());
    dragCleanupRef.current?.();
    dragRef.current = null;
    dragOrderRef.current = null;
    setDragOrder(null);
    setDragInfo(null);
  };
  const handleBatchDelete = () => {
    if (selectedCodes.size === 0) return;
    removeStocks([...selectedCodes]);
    toast.success(`已删除 ${selectedCodes.size} 只标的`);
    exitMultiSelect();
  };

  // 全选/全不选（只作用于当前组可见列表）
  const allVisibleSelected = visibleWatchlist.length > 0 && visibleWatchlist.every(s => selectedCodes.has(s.code));
  const toggleSelectAll = () => {
    setSelectedCodes(allVisibleSelected ? new Set() : new Set(visibleWatchlist.map(s => s.code)));
  };

  // 多选移动分组：加入目标组，并从当前浏览组移出（「全部」下无移出来源，即纯加入）
  const handleBatchMove = (targetId: string | null) => {
    if (selectedCodes.size === 0) return;
    const fromId = selectedGroupId === ALL_GROUP_ID ? undefined : selectedGroupId;
    moveStocksToGroup([...selectedCodes], targetId, fromId);
    const targetName = targetId ? groups.find(g => g.id === targetId)?.name ?? '' : '未分组';
    toast.success(`已移动 ${selectedCodes.size} 只到「${targetName}」`);
    setShowBatchMove(false);
    exitMultiSelect();
  };

  // 页内添加(搜索/OCR)归当前选中组；「全部」时不归组（未分组）
  const currentGroupId = selectedGroupId === ALL_GROUP_ID ? undefined : selectedGroupId;

  return (
    <div>
      {/* 添加自选（搜索/识图/粘贴文本）：添加归当前选中组，「全部」时不归组 */}
      <AddStockPanel targetGroupId={currentGroupId} />
      {/* 分组栏 */}
      <GroupBar
        selectedId={selectedGroupId}
        onSelect={setSelectedGroupId}
        onManage={() => setShowGroupManage(true)}
      />

      {/* 自选列表 */}
      {watchlist.length === 0 ? (
        <div className="text-center py-20 text-gray-400">
          <Plus className="w-16 h-16 mx-auto mb-4 opacity-20" />
          <p className="text-lg">暂无自选标的</p>
          <p className="text-sm mt-2">在上方搜索框输入标的代码添加</p>
        </div>
      ) : visibleWatchlist.length === 0 ? (
        <Card className="text-center py-16 text-gray-400">
          <FolderInput className="w-12 h-12 mx-auto mb-3 opacity-20" />
          <p className="text-base">「{activeGroupName}」暂无自选</p>
          <p className="text-sm mt-2">可搜索添加</p>
        </Card>
      ) : (
        <>
          <div className="flex items-center justify-between mb-4">
            <span className="text-sm text-gray-500">{activeGroupName} · {visibleWatchlist.length} 只</span>
            <div className="flex items-center gap-3">
              {multiSelect ? (
                <>
                  <button onClick={toggleSelectAll} className="text-sm whitespace-nowrap text-[var(--color-accent)] hover:opacity-80">
                    {allVisibleSelected ? '全不选' : '全选'}
                  </button>
                  <button onClick={exitMultiSelect} className="text-sm whitespace-nowrap text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
                    完成
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={refreshQuotes}
                    className="text-sm whitespace-nowrap text-[var(--color-accent)] hover:opacity-80 flex items-center gap-1"
                  >
                    <TrendingUp className="w-4 h-4" />
                    刷新行情
                  </button>
                  <button onClick={() => setMultiSelect(true)} className="text-sm whitespace-nowrap text-[var(--color-accent)] hover:opacity-80">
                    多选
                  </button>
                </>
              )}
            </div>
          </div>

          <div className="space-y-2">
            {(dragOrder
              ? dragOrder.map(c => visibleWatchlist.find(s => s.code === c)).filter((s): s is NonNullable<typeof s> => !!s)
              : visibleWatchlist
            ).map((stock) => {
              const quote = stockQuotes.get(stock.code);
              const cross = crossMap.get(stock.code);
              const rps60 = rpsMap[stock.code]?.rps60 ?? null;
              const isDragging = dragInfo?.code === stock.code;
              return (
                <Card
                  key={stock.code}
                  clickable
                  data-stock-code={stock.code}
                  onClick={() => {
                    // 长按刚触发多选时，松手伴随的 click 吞掉（否则会立刻反选掉长按选中的那只）
                    if (longPressRef.current.fired) { longPressRef.current.fired = false; return; }
                    if (multiSelect) toggleSelect(stock.code); else router.push(`/stock/${stock.code}`);
                  }}
                  onTouchStart={() => startLongPress(stock.code)}
                  onTouchEnd={cancelLongPress}
                  onTouchMove={cancelLongPress}
                  onContextMenu={(e) => e.preventDefault()}
                  className={cn('select-none', isDragging && 'relative z-10 shadow-lg opacity-90')}
                  style={isDragging ? { transform: `translateY(${dragInfo.offsetY}px)`, pointerEvents: 'none' } : undefined}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      {multiSelect && (
                        <span
                          className={cn(
                            'w-5 h-5 rounded border shrink-0 flex items-center justify-center transition',
                            selectedCodes.has(stock.code)
                              ? 'bg-[var(--color-accent)] border-[var(--color-accent)]'
                              : 'border-gray-300 dark:border-gray-600'
                          )}
                        >
                          {selectedCodes.has(stock.code) && <Check className="w-3.5 h-3.5 text-white" />}
                        </span>
                      )}
                      <div className="min-w-0">
                      <h3 className="font-semibold">
                        {stock.name}
                        {rps60 != null && (
                          <span
                            title={`RPS60 相对强度 ${Math.round(rps60)}（全市场百分位，${rpsMap[stock.code]?.calcDate ?? ''} 计算）`}
                            className={cn(
                              'inline-block align-middle ml-1.5 px-1.5 py-0.5 text-[10px] font-medium rounded',
                              rps60 >= 87
                                ? 'bg-[var(--color-up-soft)] text-[var(--color-up)]'
                                : rps60 <= 20
                                  ? 'bg-[var(--color-down-soft)] text-[var(--color-down)]'
                                  : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'
                            )}
                          >
                            RPS {Math.round(rps60)}
                          </span>
                        )}
                        {isETF(stock.code) && (
                          <span className="inline-block align-middle ml-1.5 px-1.5 py-0.5 text-[10px] font-bold bg-[var(--color-warning-soft)] text-[var(--color-warning)] rounded">ETF</span>
                        )}
                        {cross && (
                          <span
                            title={cross === 'golden' ? 'MA5 近3日内上穿 MA13' : cross === 'death' ? 'MA5 近3日内下穿 MA13' : 'MA5 逼近 MA13（差距<2%）且上行，可能即将金叉'}
                            className={cn(
                              'inline-block align-middle ml-1.5 px-1.5 py-0.5 text-[10px] font-medium rounded',
                              cross === 'golden' && 'bg-[var(--color-up-soft)] text-[var(--color-up)]',
                              cross === 'death' && 'bg-[var(--color-down-soft)] text-[var(--color-down)]',
                              cross === 'pending' && 'bg-[var(--color-warning-soft)] text-[var(--color-warning)]',
                            )}
                          >
                            {cross === 'golden' ? '金叉' : cross === 'death' ? '死叉' : '即将金叉'}
                          </span>
                        )}
                      </h3>
                      <p className="text-sm text-gray-500">{stock.code}</p>
                      </div>
                    </div>
                    {quote ? (
                      <div className="flex items-center gap-4">
                        <div className="text-right">
                          <p className={cn("font-semibold text-lg", quote.changePercent >= 0 ? "text-[var(--color-up)]" : "text-[var(--color-down)]")}>
                            {formatPrice(quote.price)}
                          </p>
                          <p className={cn("text-sm", quote.changePercent >= 0 ? "text-[var(--color-up)]" : "text-[var(--color-down)]")}>
                            {formatChange(quote.changePercent)}
                          </p>
                        </div>
                        {!multiSelect && (
                          <>
                            <div className="relative">
                              <button
                                onClick={(e) => { e.stopPropagation(); setMoveMenuFor(moveMenuFor === stock.code ? null : stock.code); }}
                                className="p-2 text-gray-400 hover:text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)] rounded-[var(--radius-md)] transition"
                                title="分组"
                              >
                                <FolderInput className="w-4 h-4" />
                              </button>
                              {moveMenuFor === stock.code && (
                                <MoveToGroupMenu
                                  code={stock.code}
                                  onClose={() => setMoveMenuFor(null)}
                                  onCreateGroup={() => setShowGroupManage(true)}
                                />
                              )}
                            </div>
                            <button
                              onClick={(e) => { e.stopPropagation(); removeFromWatchlist(stock.code); }}
                              className="p-2 text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)] rounded-[var(--radius-md)] transition"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </>
                        )}
                      </div>
                    ) : (
                      <div className="text-gray-400 text-sm">加载中...</div>
                    )}
                    {multiSelect && (
                      <button
                        onPointerDown={(e) => handleGripDown(e, stock.code)}
                        onTouchStart={(e) => e.stopPropagation()}
                        onClick={(e) => e.stopPropagation()}
                        title="按住拖动排序"
                        className="p-2 -mr-2 shrink-0 text-gray-300 dark:text-gray-600 hover:text-gray-500 cursor-grab active:cursor-grabbing touch-none"
                      >
                        <Menu className="w-4 h-4" />
                      </button>
                    )}
                  </div>

                  {quote && !multiSelect && (
                    <div className="mt-2 flex items-center text-sm">
                      {/* 持仓占比输入 */}
                      <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                        <span className="text-gray-400 text-xs">持仓占比</span>
                        <Input
                          type="number"
                          min="0"
                          max="100"
                          block={false}
                          value={stock.positionPercent ?? ''}
                          placeholder="--"
                          onChange={(e) => {
                            const val = e.target.value === '' ? undefined : Math.min(100, Math.max(0, Number(e.target.value)));
                            useStockStore.getState().updateStockPosition(stock.code, val);
                          }}
                          className="w-14 px-2 py-1 text-xs text-center"
                        />
                        <span className="text-gray-400 text-xs">%</span>
                      </div>
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        </>
      )}

      {/* 组内添加入口：只在具体分组视角显示（「全部」用页顶搜索卡即可） */}
      {selectedGroupId !== ALL_GROUP_ID && (
        <button
          onClick={() => setShowGroupAdd(true)}
          className="w-full mt-4 py-3 border-2 border-dashed border-gray-200 dark:border-gray-700 rounded-xl text-sm text-gray-500 dark:text-gray-400 hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition flex items-center justify-center gap-1.5"
        >
          <Plus className="w-4 h-4" />
          添加标的到「{activeGroupName}」
        </button>
      )}

      {/* 组内添加弹窗：从已有自选勾选 + 搜索/识图（复用 AddStockPanel） */}
      {showGroupAdd && selectedGroupId !== ALL_GROUP_ID && (
        <Modal title={`添加到「${activeGroupName}」`} onClose={() => setShowGroupAdd(false)}>
          <div className="p-4">
            {watchlist.length > 0 && (
              <>
                <p className="text-xs text-gray-400 mb-1.5">从自选列表勾选</p>
                <div className="max-h-[30vh] overflow-y-auto space-y-1 mb-4">
                  {watchlist.map(s => {
                    const inGroup = groups.find(g => g.id === selectedGroupId)?.stockCodes.includes(s.code) ?? false;
                    return (
                      <button
                        key={s.code}
                        onClick={() => toggleStockGroup(s.code, selectedGroupId)}
                        className={cn(
                          'w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm transition',
                          inGroup
                            ? 'text-[var(--color-accent)] bg-[var(--color-accent-soft)]'
                            : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
                        )}
                      >
                        <span className="min-w-0 truncate">
                          <span className="font-medium">{s.name}</span>
                          <span className="text-xs text-gray-400 ml-2">{s.code}</span>
                        </span>
                        {inGroup && <Check className="w-4 h-4 shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
            <p className="text-xs text-gray-400 mb-1.5">搜索 / 识图添加新标的</p>
            <AddStockPanel targetGroupId={selectedGroupId} variant="bare" />
          </div>
        </Modal>
      )}

      {/* 多选删除操作栏 */}
      {multiSelect && (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 px-4 py-2.5 rounded-full bg-gray-900 dark:bg-white text-white dark:text-gray-900 shadow-lg">
          <span className="text-sm whitespace-nowrap">已选 {selectedCodes.size} 只</span>
          {groups.length > 0 && (
            <button
              onClick={() => setShowBatchMove(true)}
              disabled={selectedCodes.size === 0}
              className="px-3.5 py-1 rounded-full bg-[var(--color-accent)] text-white text-sm font-medium whitespace-nowrap disabled:opacity-40"
            >
              移动分组
            </button>
          )}
          <button
            onClick={handleBatchDelete}
            disabled={selectedCodes.size === 0}
            className="px-3.5 py-1 rounded-full bg-[var(--color-danger)] text-white text-sm font-medium whitespace-nowrap disabled:opacity-40"
          >
            删除
          </button>
          <button onClick={exitMultiSelect} className="text-sm whitespace-nowrap opacity-70">取消</button>
        </div>
      )}

      {/* 多选移动分组弹窗：在「全部」下为加入目标组；在具体分组下为移出当前组并加入目标组 */}
      {showBatchMove && (
        <Modal title={`移动 ${selectedCodes.size} 只到分组`} onClose={() => setShowBatchMove(false)} variant="center" maxWidth="sm:max-w-sm">
          <div className="p-4 space-y-1.5 max-h-[60vh] overflow-y-auto">
            {selectedGroupId !== ALL_GROUP_ID && (
              <button
                onClick={() => handleBatchMove(null)}
                className="w-full text-left px-3 py-2.5 rounded-lg text-sm hover:bg-gray-100 dark:hover:bg-gray-800 transition"
              >
                未分组<span className="text-xs text-gray-400 ml-1.5">（移出「{activeGroupName}」）</span>
              </button>
            )}
            {groups.filter(g => g.id !== selectedGroupId).map(g => (
              <button
                key={g.id}
                onClick={() => handleBatchMove(g.id)}
                className="w-full text-left px-3 py-2.5 rounded-lg text-sm hover:bg-gray-100 dark:hover:bg-gray-800 transition"
              >
                {g.name}
                <span className="text-xs text-gray-400 ml-1.5">{g.stockCodes.length} 只</span>
              </button>
            ))}
          </div>
        </Modal>
      )}

      {showGroupManage && <GroupManageModal onClose={() => setShowGroupManage(false)} />}
    </div>
  );
}
