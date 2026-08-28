'use client';

/**
 * 复盘日历（纯内容组件）—— 复盘弹窗「复盘日历」tab。
 * 数据源 /api/review-calendar（review_calendar_days 预计算小表，只读）。
 * 月历格默认按上证涨跌着色（红涨绿跌），可切换为三态周期视角；❄=量能冰点；
 * 点某天看当日详情（三大指数/涨跌家数/涨跌停/成交额/量能）。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, CalendarDays, Snowflake } from 'lucide-react';
import { cn } from '@/lib/utils';

interface MonthDay {
  date: string;
  advance: number | null; decline: number | null; flat: number | null;
  limitUp: number | null; limitDown: number | null;
  amountYi: number | null;
  volumeRatio: number | null;
  idxPctChg: number | null;
  isIcePoint: boolean; iceLevel: string | null;
  regime: 'attack' | 'neutral' | 'defense' | null;
  regimeDay: number | null;
}

interface DayDetail {
  date: string;
  advance: number | null; decline: number | null; flat: number | null;
  limitUp: number | null; limitDown: number | null;
  amountYi: number | null;
  volumeRatio: number | null;
  volPctile60d: number | null; volPctile120d: number | null;
  upPctile60d: number | null; upPctile120d: number | null;
  idxPctChg: number | null;
  isIcePoint: boolean; iceLevel: string | null; iceConfidence: string | null;
  regime: string | null; regimeDay: number | null;
  indices: { code: string; name: string; close: number | null; pctChg: number | null }[];
}

const REGIME_TEXT: Record<string, string> = { attack: '活跃', neutral: '震荡', defense: '收缩' };
const signed = (v: number | null | undefined) => (v == null ? '--' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);
const amount = (yi: number | null) => yi == null ? '--' : yi >= 10000 ? `${(yi / 10000).toFixed(2)} 万亿` : `${yi.toFixed(0)} 亿`;
const ratio = (r: number | null) => (r == null ? '--' : `${(r * 100).toFixed(1)}%`);
const signedShort = (v: number | null | undefined) => (v == null ? '--' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`);

type Heat = 'strong-up' | 'up' | 'flat' | 'down' | 'strong-down' | 'none';
function heatOf(idxPctChg: number | null | undefined): Heat {
  if (idxPctChg == null) return 'none';
  if (idxPctChg >= 1.5) return 'strong-up';
  if (idxPctChg > 0) return 'up';
  if (idxPctChg <= -1.5) return 'strong-down';
  if (idxPctChg < 0) return 'down';
  return 'flat';
}
const HEAT_CELL: Record<Heat, string> = {
  'strong-up': 'bg-[var(--color-up)]/25 text-[var(--color-up)]',
  up: 'bg-[var(--color-up)]/10 text-[var(--color-up)]',
  flat: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
  down: 'bg-[var(--color-down)]/10 text-[var(--color-down)]',
  'strong-down': 'bg-[var(--color-down)]/25 text-[var(--color-down)]',
  none: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
};

function MiniStat({ label, main, sub, tone }: { label: string; main: string; sub?: string; tone?: 'up' | 'down' | 'blue' }) {
  return (
    <div className="text-center bg-white/60 dark:bg-gray-900/40 rounded-[var(--radius-md)] py-2 px-1">
      <div className="text-[10px] text-gray-400 truncate">{label}</div>
      <div className={cn('text-sm font-bold leading-tight tabular-nums', tone === 'up' ? 'text-[var(--color-up)]' : tone === 'down' ? 'text-[var(--color-down)]' : tone === 'blue' ? 'text-blue-600 dark:text-blue-400' : 'text-gray-800 dark:text-gray-100')}>{main}</div>
      {sub && <div className="text-[10px] text-gray-400 truncate">{sub}</div>}
    </div>
  );
}

export function ReviewCalendar() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth()); // 0-11
  const [days, setDays] = useState<MonthDay[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<DayDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [forwardStats, setForwardStats] = useState<Record<string, { n: number; fwd: Record<number, { n: number; winRate: number | null; mean: number | null }> }> | null>(null);
  const [viewMode, setViewMode] = useState<'market' | 'regime'>('market');

  const ym = useMemo(() => `${year}-${String(month + 1).padStart(2, '0')}`, [year, month]);

  const load = useCallback(async () => {
    setLoading(true);
    setSelected(null);
    setDetail(null);
    try {
      const res = await fetch(`/api/review-calendar?month=${ym}`);
      const json = await res.json();
      setDays(json?.data?.days ?? []);
      setForwardStats(json?.data?.forwardStats ?? null);
    } catch {
      setDays([]);
    } finally {
      setLoading(false);
    }
  }, [ym]);

  useEffect(() => { load(); }, [load]);

  const openDetail = useCallback(async (date: string) => {
    setSelected(date);
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/review-calendar?date=${date}`);
      const json = await res.json();
      setDetail(json?.data ?? null);
    } catch {
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const byDate = useMemo(() => {
    const m = new Map<string, MonthDay>();
    for (const d of days) m.set(d.date, d);
    return m;
  }, [days]);

  const marketSummary = useMemo(() => {
    let up = 0, down = 0, flat = 0, ice = 0, limitUp = 0, limitDown = 0, sum = 0, n = 0;
    let best: MonthDay | null = null;
    let worst: MonthDay | null = null;
    for (const d of days) {
      if (d.isIcePoint) ice++;
      if (d.limitUp != null) limitUp += d.limitUp;
      if (d.limitDown != null) limitDown += d.limitDown;
      if (d.idxPctChg != null) {
        sum += d.idxPctChg; n++;
        if (d.idxPctChg > 0) up++;
        else if (d.idxPctChg < 0) down++;
        else flat++;
        if (!best || d.idxPctChg > (best.idxPctChg ?? -Infinity)) best = d;
        if (!worst || d.idxPctChg < (worst.idxPctChg ?? Infinity)) worst = d;
      }
    }
    return { up, down, flat, ice, limitUp, limitDown, avg: n ? sum / n : null, best, worst };
  }, [days]);

  const regimeSummary = useMemo(() => {
    let attack = 0, neutral = 0, defense = 0, ice = 0;
    for (const d of days) {
      if (d.regime === 'attack') attack++;
      else if (d.regime === 'defense') defense++;
      else if (d.regime === 'neutral') neutral++;
      if (d.isIcePoint) ice++;
    }
    return { attack, neutral, defense, ice };
  }, [days]);

  const cells = useMemo(() => {
    const first = new Date(year, month, 1);
    const offset = (first.getDay() + 6) % 7; // 周一为 0
    const count = new Date(year, month + 1, 0).getDate();
    const arr: ({ day: number; date: string; data?: MonthDay; today: boolean })[] = [];
    for (let i = 0; i < offset; i++) arr.push({ day: 0, date: '', today: false });
    for (let d = 1; d <= count; d++) {
      const ds = `${year}${String(month + 1).padStart(2, '0')}${String(d).padStart(2, '0')}`;
      arr.push({ day: d, date: ds, data: byDate.get(ds), today: ds === `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}` });
    }
    while (arr.length % 7 !== 0) arr.push({ day: 0, date: '', today: false });
    return arr;
  }, [year, month, byDate, now]);

  const nav = (delta: number) => {
    let m = month + delta;
    let y = year;
    if (m < 0) { m = 11; y--; }
    if (m > 11) { m = 0; y++; }
    setYear(y); setMonth(m);
  };
  const backToday = () => { setYear(now.getFullYear()); setMonth(now.getMonth()); };

  const cellCls = (d?: MonthDay) => {
    if (!d) return 'bg-transparent text-transparent pointer-events-none';
    const base = 'aspect-square rounded-[var(--radius-md)] text-xs font-medium flex flex-col items-center justify-center relative cursor-pointer transition hover:ring-2 hover:ring-[var(--color-accent)]/40';
    const tone = viewMode === 'market'
      ? HEAT_CELL[heatOf(d.idxPctChg)]
      : d.regime === 'attack'
        ? 'bg-[var(--color-up)]/10 text-[var(--color-up)]'
        : d.regime === 'defense'
          ? 'bg-[var(--color-down)]/10 text-[var(--color-down)]'
          : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400';
    return cn(base, tone);
  };

  const cellTitle = (d?: MonthDay) => {
    if (!d) return undefined;
    const date = `${d.date.slice(0, 4)}-${d.date.slice(4, 6)}-${d.date.slice(6, 8)}`;
    const parts = [date, `上证 ${signed(d.idxPctChg)}`, `涨/跌 ${d.advance ?? '--'}/${d.decline ?? '--'}`, `涨停/跌停 ${d.limitUp ?? '--'}/${d.limitDown ?? '--'}`];
    if (d.regime) parts.push(REGIME_TEXT[d.regime] ?? d.regime);
    return parts.join(' · ');
  };

  return (
    <div className="p-5">
      {/* 标题 + 月份导航 */}
      <div className="flex items-center justify-between pb-3 border-b border-gray-100 dark:border-gray-800">
        <div className="flex items-center gap-1.5">
          <CalendarDays className="w-4 h-4 text-[var(--color-accent)]" />
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">复盘日历</h3>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => nav(-1)} className="p-1 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500" aria-label="上个月"><ChevronLeft className="w-4 h-4" /></button>
          <span className="text-sm font-medium tabular-nums text-gray-700 dark:text-gray-200">{year} 年 {month + 1} 月</span>
          <button onClick={() => nav(1)} className="p-1 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500" aria-label="下个月"><ChevronRight className="w-4 h-4" /></button>
          <button onClick={backToday} className="ml-1 px-2 py-1 text-xs rounded-md bg-gray-100 dark:bg-gray-800 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">回到本月</button>
        </div>
      </div>

      {/* 视图切换：默认按市场涨跌着色，周期状态作为次级视角 */}
      <div className="flex items-center justify-between gap-2 mt-2">
        <div className="flex gap-1 p-0.5 bg-gray-100 dark:bg-gray-800/50 rounded-lg">
          <button onClick={() => setViewMode('market')} className={cn('px-2 py-1 rounded-md text-xs font-medium transition', viewMode === 'market' ? 'bg-white dark:bg-gray-900 text-[var(--color-accent)] shadow-sm' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300')}>市场涨跌</button>
          <button onClick={() => setViewMode('regime')} className={cn('px-2 py-1 rounded-md text-xs font-medium transition', viewMode === 'regime' ? 'bg-white dark:bg-gray-900 text-[var(--color-accent)] shadow-sm' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300')}>周期状态</button>
        </div>
        <span className="text-[10px] text-gray-400">{viewMode === 'market' ? '红涨绿跌 · 点日期看详情' : '三态周期有滞回，不等同单日涨跌'}</span>
      </div>

      {/* 月内速览 */}
      {!loading && days.length > 0 && (viewMode === 'market' ? (
        <div className="mt-3 grid grid-cols-3 sm:grid-cols-6 gap-2">
          <MiniStat label="上涨天数" main={String(marketSummary.up)} sub={`下跌 ${marketSummary.down}`} tone="up" />
          <MiniStat label="下跌天数" main={String(marketSummary.down)} sub={`平盘 ${marketSummary.flat}`} tone="down" />
          <MiniStat label="上证日均涨跌" main={signedShort(marketSummary.avg)} tone={(marketSummary.avg ?? 0) >= 0 ? 'up' : 'down'} />
          <MiniStat label="涨停合计" main={String(marketSummary.limitUp)} sub={`跌停 ${marketSummary.limitDown}`} tone="up" />
          <MiniStat label="量能冰点" main={String(marketSummary.ice)} sub="天" tone="blue" />
          <MiniStat label="本月最佳" main={marketSummary.best ? signedShort(marketSummary.best.idxPctChg) : '--'} sub={marketSummary.best ? marketSummary.best.date.slice(4, 6) + '-' + marketSummary.best.date.slice(6, 8) : undefined} tone="up" />
        </div>
      ) : (
        <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
          <MiniStat label="活跃" main={String(regimeSummary.attack)} sub="天" tone="up" />
          <MiniStat label="震荡" main={String(regimeSummary.neutral)} sub="天" />
          <MiniStat label="收缩" main={String(regimeSummary.defense)} sub="天" tone="down" />
          <MiniStat label="量能冰点" main={String(regimeSummary.ice)} sub="天" tone="blue" />
        </div>
      ))}

      {loading && <div className="text-center py-16 text-gray-400 text-sm">加载中...</div>}
      {!loading && days.length === 0 && (
        <div className="text-center py-16">
          <CalendarDays className="w-12 h-12 mx-auto mb-3 opacity-20" />
          <p className="text-gray-500">该月暂无行情数据</p>
        </div>
      )}
      {!loading && days.length > 0 && (
        <div className="mt-3">
          {/* 星期表头 */}
          <div className="grid grid-cols-7 gap-1.5 mb-1.5">
            {['一', '二', '三', '四', '五', '六', '日'].map((w) => (
              <div key={w} className="text-center text-[10px] text-gray-400">{w}</div>
            ))}
          </div>
          {/* 日期格 */}
          <div className="grid grid-cols-7 gap-1.5">
            {cells.map((c, i) => (
              <button
                key={i}
                disabled={!c.data}
                onClick={() => c.data && openDetail(c.date)}
                className={cn(cellCls(c.data), selected === c.date && 'ring-2 ring-[var(--color-accent)]', c.today && !c.data && 'ring-1 ring-gray-200')}
                title={cellTitle(c.data)}
              >
                {c.day > 0 && (
                  <>
                    <span className="leading-none">{c.day}</span>
                    {viewMode === 'market' && c.data?.idxPctChg != null && (
                      <span className="mt-0.5 text-[9px] leading-none tabular-nums opacity-75">{signedShort(c.data.idxPctChg)}</span>
                    )}
                    {c.data?.isIcePoint && (
                      <span className={cn('absolute top-0.5 right-0.5 text-[9px] leading-none', c.data.iceLevel === '极冰' ? 'text-blue-600 dark:text-blue-400' : 'text-blue-400 dark:text-blue-500')} title={`量能${c.data.iceLevel}`}><Snowflake className="w-2.5 h-2.5" /></span>
                    )}
                  </>
                )}
              </button>
            ))}
          </div>
          {/* 图例 */}
          <div className="flex flex-wrap gap-x-3 gap-y-1 mt-3 text-[10px] text-gray-400">
            {viewMode === 'market' ? (
              <>
                <span className="flex items-center gap-1"><i className="w-2 h-2 rounded-sm bg-[var(--color-up)]/25" /> 大涨 ≥1.5%</span>
                <span className="flex items-center gap-1"><i className="w-2 h-2 rounded-sm bg-[var(--color-up)]/10" /> 上涨</span>
                <span className="flex items-center gap-1"><i className="w-2 h-2 rounded-sm bg-gray-300 dark:bg-gray-600" /> 平盘</span>
                <span className="flex items-center gap-1"><i className="w-2 h-2 rounded-sm bg-[var(--color-down)]/10" /> 下跌</span>
                <span className="flex items-center gap-1"><i className="w-2 h-2 rounded-sm bg-[var(--color-down)]/25" /> 大跌 ≤-1.5%</span>
              </>
            ) : (
              <>
                <span className="flex items-center gap-1"><i className="w-2 h-2 rounded-sm bg-[var(--color-up)]/10" /> 活跃</span>
                <span className="flex items-center gap-1"><i className="w-2 h-2 rounded-sm bg-gray-300 dark:bg-gray-600" /> 震荡</span>
                <span className="flex items-center gap-1"><i className="w-2 h-2 rounded-sm bg-[var(--color-down)]/10" /> 收缩</span>
              </>
            )}
            <span className="flex items-center gap-1"><Snowflake className="w-2.5 h-2.5 text-blue-500" /> 量能冰点</span>
          </div>
        </div>
      )}

      {/* 当日详情 */}
      {(selected || detailLoading) && (
        <div className="mt-4 rounded-[var(--radius-lg)] bg-gray-50 dark:bg-gray-900/40 p-3">
          {detailLoading && <div className="text-center py-6 text-gray-400 text-sm">加载中...</div>}
          {!detailLoading && !detail && <div className="text-center py-6 text-gray-400 text-sm">该日暂无详情</div>}
          {!detailLoading && detail && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs font-semibold text-gray-700 dark:text-gray-200">{detail.date.slice(0,4)}-{detail.date.slice(4,6)}-{detail.date.slice(6,8)}</div>
                <div className="flex items-center gap-1.5 text-[10px]">
                  {detail.idxPctChg != null && (
                    <span className={cn('px-1.5 py-0.5 rounded bg-white dark:bg-gray-800', (detail.idxPctChg ?? 0) >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]')}>{detail.idxPctChg >= 0 ? '上证上涨' : '上证下跌'} {signed(detail.idxPctChg)}</span>
                  )}
                  {detail.regime && <span className="px-1.5 py-0.5 rounded bg-white dark:bg-gray-800 text-gray-500" title="三态周期状态，与单日涨跌不同口径">{REGIME_TEXT[detail.regime] ?? detail.regime}{detail.regimeDay ? ` ${detail.regimeDay} 天` : ''}</span>}
                  {detail.iceLevel && <span className="px-1.5 py-0.5 rounded bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400">量能{detail.iceLevel}</span>}
                </div>
              </div>
              {detail.iceLevel && forwardStats?.[detail.iceLevel]?.fwd?.[5]?.winRate != null && (
                <div className="text-[10px] text-gray-400 mb-2">历史同类日后 5 个交易日：上涨占比 {forwardStats[detail.iceLevel].fwd[5].winRate}%（{forwardStats[detail.iceLevel].fwd[5].n} 例）</div>
              )}
              <div className="grid grid-cols-3 gap-1.5 mb-2">
                {detail.indices.map((x) => (
                  <div key={x.code} className="bg-white dark:bg-gray-800 rounded-[var(--radius-md)] px-2 py-1.5 text-center">
                    <div className="text-[10px] text-gray-400 truncate">{x.name}</div>
                    <div className={cn('text-xs font-semibold tabular-nums', (x.pctChg ?? 0) >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]')}>{signed(x.pctChg)}</div>
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-3 gap-1.5 text-center">
                <div className="bg-white dark:bg-gray-800 rounded-[var(--radius-md)] px-2 py-1.5">
                  <div className="text-[10px] text-gray-400">涨 / 跌 / 平</div>
                  <div className="text-xs font-semibold tabular-nums text-gray-700 dark:text-gray-200">{detail.advance ?? '--'} / {detail.decline ?? '--'} / {detail.flat ?? '--'}</div>
                </div>
                <div className="bg-white dark:bg-gray-800 rounded-[var(--radius-md)] px-2 py-1.5">
                  <div className="text-[10px] text-gray-400">涨停 / 跌停</div>
                  <div className="text-xs font-semibold tabular-nums text-gray-700 dark:text-gray-200">{detail.limitUp ?? '--'} / {detail.limitDown ?? '--'}</div>
                </div>
                <div className="bg-white dark:bg-gray-800 rounded-[var(--radius-md)] px-2 py-1.5">
                  <div className="text-[10px] text-gray-400">成交额</div>
                  <div className="text-xs font-semibold tabular-nums text-gray-700 dark:text-gray-200">{amount(detail.amountYi)}</div>
                </div>
                <div className="bg-white dark:bg-gray-800 rounded-[var(--radius-md)] px-2 py-1.5">
                  <div className="text-[10px] text-gray-400">量能比</div>
                  <div className="text-xs font-semibold tabular-nums text-gray-700 dark:text-gray-200">{ratio(detail.volumeRatio)}</div>
                </div>
                <div className="bg-white dark:bg-gray-800 rounded-[var(--radius-md)] px-2 py-1.5">
                  <div className="text-[10px] text-gray-400">上证</div>
                  <div className={cn('text-xs font-semibold tabular-nums', (detail.idxPctChg ?? 0) >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]')}>{signed(detail.idxPctChg)}</div>
                </div>
                <div className="bg-white dark:bg-gray-800 rounded-[var(--radius-md)] px-2 py-1.5">
                  <div className="text-[10px] text-gray-400">量能分位</div>
                  <div className="text-xs font-semibold tabular-nums text-gray-700 dark:text-gray-200">{detail.volPctile60d != null ? `${detail.volPctile60d.toFixed(0)}%` : '--'}</div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
