'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { CalendarDays } from 'lucide-react';

/**
 * 分层筛选 tab
 *
 * 展示最新一期入选结果 + 历史战绩（持有 20 个交易日的超额）。
 * 数据由 scripts/funnel-backfill.ts 回填/日更写入 funnel_picks。
 *
 * 文案约束（docs/memory/ui-copy-compliance.md）：不出现「股」字、不解释实现细节。
 */

interface Pick {
  pick_date: string;
  rank_no: number;
  ts_code: string;
  name: string | null;
  reason: string | null;
  turnover_rate: number | null;
  turnover_q: number | null;
  past20: number | null;
  veto_hit: boolean;
  veto_types: string | null;
  ret5: number | null;
  ret20: number | null;
  ex5: number | null;
  ex20: number | null;
  settled: boolean;
  board_code?: string | null;
  board_name?: string | null;
  board_reason?: string | null;
  llm_thesis?: string | null;
  llm_counter?: string | null;
}
interface DayRow {
  pick_date: string; n: number;
  ret5: number | null; ret10: number | null; ret20: number | null;
  ex5: number | null; ex10: number | null; ex20: number | null;
  win20: number | null; settled: boolean;
}
interface Stats {
  days: number; picks: number;
  ret5: number | null; ret10: number | null; ret20: number | null;
  ex5: number | null; ex10: number | null; ex20: number | null;
  win20: number | null; date_from: string | null; date_to: string | null;
}
interface YearRow { yr: string; days: number; ex5: number | null; ex10: number | null; ex20: number | null; win20: number | null }

const pct = (v: number | null | undefined, digits = 2) =>
  v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`;
const tone = (v: number | null | undefined) =>
  v == null ? 'text-gray-400' : v > 0 ? 'text-red-600 dark:text-red-400' : v < 0 ? 'text-green-600 dark:text-green-400' : 'text-gray-500';

export function FunnelTab() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [days, setDays] = useState(40);

  // 日历：按月拉有入选记录的交易日，点某天看当天选出的标的
  const now = new Date();
  const [ym, setYm] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const [calDays, setCalDays] = useState<DayRow[]>([]);
  const [selDate, setSelDate] = useState<string | null>(null);
  const [dayPicks, setDayPicks] = useState<Pick[] | null>(null);
  const [dayLoading, setDayLoading] = useState(false);
  const [calOpen, setCalOpen] = useState(false); // 日历默认收起，常态是左右箭头切前后一天

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetch(`/api/funnel?days=${days}`)
      .then((r) => r.json())
      .then((j) => { if (alive) { setData(j); setErr(j?.error ?? null); } })
      .catch((e) => { if (alive) setErr(String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [days]);

  useEffect(() => {
    const mm = `${ym.y}-${String(ym.m + 1).padStart(2, '0')}`;
    let alive = true;
    fetch(`/api/funnel?month=${mm}`)
      .then((r) => r.json())
      .then((j) => {
        if (!alive || !j?.ready) return;
        const ds: string[] = (j.days ?? []).map((d: any) => d.pick_date);
        setCalDays(j.days ?? []);
        // 默认停在最近一个有入选的交易日，左右箭头从它开始切
        setSelDate((cur) => (cur && ds.includes(cur) ? cur : ds[ds.length - 1] ?? null));
      })
      .catch(() => { /* 日历取数失败不影响其余区块 */ });
    return () => { alive = false; };
  }, [ym.y, ym.m]);

  const [reloadDay, setReloadDay] = useState(0);
  const openDate = (d: string) => { setSelDate(d); setReloadDay((n) => n + 1); };

  useEffect(() => {
    if (!selDate) { setDayPicks(null); return; }
    let alive = true;
    setDayPicks(null); setDayLoading(true);
    fetch(`/api/funnel?date=${selDate}`)
      .then((r) => r.json())
      .then((j) => { if (alive) setDayPicks(j?.picks ?? []); })
      .catch(() => { if (alive) setDayPicks([]); })
      .finally(() => { if (alive) setDayLoading(false); });
    return () => { alive = false; };
  }, [selDate, reloadDay]);

  if (loading && !data) return <div className="text-sm text-gray-500 py-12 text-center">加载中…</div>;
  if (err) return <div className="text-sm text-gray-500 py-12 text-center">读取失败：{err}</div>;
  if (!data?.ready || !data?.latest) {
    return <div className="text-sm text-gray-500 py-12 text-center">暂无入选记录</div>;
  }

  const picks: Pick[] = data.latest.picks ?? [];
  const st: Stats | null = data.stats;
  const hist: DayRow[] = data.history ?? [];
  const years: YearRow[] = data.byYear ?? [];

  // 日历派生量：**只显示周一到周五**（周末不推荐，也没有入选记录）
  const calByDate = new Map(calDays.map((d) => [d.pick_date, d]));
  const calCells: (number | null)[] = [];
  {
    const last = new Date(ym.y, ym.m + 1, 0).getDate();
    const lead = (new Date(ym.y, ym.m, 1).getDay() + 6) % 7; // 周一为 0
    for (let i = 0; i < Math.min(lead, 5); i++) calCells.push(null);
    for (let d = 1; d <= last; d++) {
      const dow = new Date(ym.y, ym.m, d).getDay();
      if (dow === 0 || dow === 6) continue; // 跳过周六周日
      calCells.push(d);
    }
    while (calCells.length % 5 !== 0) calCells.push(null);
  }

  // 有入选记录的交易日（升序），供左右箭头切换
  const tradeDays = calDays.map((d) => d.pick_date);
  const stepDay = (dir: -1 | 1) => {
    if (!tradeDays.length) return;
    const cur = selDate ?? tradeDays[tradeDays.length - 1];
    const i = tradeDays.indexOf(cur);
    const j = i < 0 ? tradeDays.length - 1 : Math.min(Math.max(i + dir, 0), tradeDays.length - 1);
    if (tradeDays[j] !== selDate) openDate(tradeDays[j]);
  };

  return (
    <div className="space-y-5">
      {/* 最新一期 */}
      <section>
        <div className="flex items-baseline justify-between mb-2">
          <h3 className="text-sm font-medium">今日推荐 · {fmtDate(data.latest.pickDate)}</h3>
          <span className="text-xs text-gray-400">买入后持有 20 个交易日</span>
        </div>
        <p className="text-xs text-gray-500 leading-relaxed mb-2">
          从主板里挑<strong className="text-gray-700 dark:text-gray-300">「最近确实在急跌、又没被炒到最热」</strong>的：
          先取近 20 日跌幅榜前列，再要求近 5 日跌幅超过 5%、且成交没有极度萎缩。
          这样能避开<strong className="text-gray-700 dark:text-gray-300">阴跌中继</strong>（跌得多但还在跌）。
          <strong className="text-gray-700 dark:text-gray-300">全市场都没有符合条件的就不推荐</strong> —— 宁缺勿滥。
        </p>
        <div className="space-y-2">
          {picks.map((p) => (
            <Link
              key={p.ts_code}
              href={`/stock/${p.ts_code.split('.')[0]}`}
              className="block rounded-lg border border-gray-200 dark:border-gray-800 p-3 hover:border-gray-300 dark:hover:border-gray-700 transition"
            >
              <div className="flex items-center gap-2">
                <span className="w-5 h-5 shrink-0 rounded text-[11px] leading-5 text-center bg-gray-100 dark:bg-gray-800 text-gray-500">{p.rank_no}</span>
                <span className="font-medium">{p.name || p.ts_code}</span>
                <span className="text-xs text-gray-400">{p.ts_code}</span>
                {p.veto_hit && <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">风险提示</span>}
                <span className="ml-auto text-xs text-gray-500">
                  近一月 <span className={tone(p.past20)}>{pct(p.past20, 1)}</span>
                </span>
              </div>
              {p.board_name && (
                <div className="mt-1 text-[11px] text-blue-600 dark:text-blue-400 leading-relaxed">
                  来自「{p.board_name}」—— {p.board_reason}
                </div>
              )}
              {p.llm_thesis ? (
                <div className="mt-1.5 space-y-1">
                  <div className="text-xs text-gray-700 dark:text-gray-300 leading-relaxed">
                    <span className="text-[10px] px-1 py-0.5 rounded bg-purple-50 dark:bg-purple-950/40 text-purple-600 dark:text-purple-300 mr-1">模型分析</span>
                    {p.llm_thesis}
                  </div>
                  {p.llm_counter && (
                    <div className="text-xs text-gray-500 leading-relaxed">
                      <span className="text-red-500">🔴 反面：</span>{p.llm_counter}
                    </div>
                  )}
                </div>
              ) : (
                p.reason && <div className="mt-1.5 text-xs text-gray-500 leading-relaxed">{p.reason}</div>
              )}
            </Link>
          ))}
        </div>
      </section>

      {/* 查历史入选：常态是左右箭头切前后一天，点日历图标才展开月历 */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium">查历史入选</h3>
          <div className="flex items-center gap-1 text-xs">
            <button
              onClick={() => stepDay(-1)}
              disabled={!tradeDays.length}
              className="w-6 h-6 rounded border border-gray-200 dark:border-gray-800 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 disabled:opacity-40"
            >‹</button>
            <span className="tabular-nums w-24 text-center text-gray-600 dark:text-gray-300">
              {selDate ? fmtDate(selDate) : '—'}
            </span>
            <button
              onClick={() => stepDay(1)}
              disabled={!tradeDays.length}
              className="w-6 h-6 rounded border border-gray-200 dark:border-gray-800 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 disabled:opacity-40"
            >›</button>
            <button
              onClick={() => setCalOpen((v) => !v)}
              title={calOpen ? '收起日历' : '展开日历'}
              className={cn('ml-1 w-6 h-6 rounded border flex items-center justify-center transition',
                calOpen ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                        : 'border-gray-200 dark:border-gray-800 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200')}
            >
              <CalendarDays className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {calOpen && (
          <div className="mb-3">
            <div className="flex items-center justify-center gap-2 text-xs mb-1.5">
              <button
                onClick={() => setYm(({ y, m }) => (m === 0 ? { y: y - 1, m: 11 } : { y, m: m - 1 }))}
                className="w-5 h-5 rounded text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"
              >‹</button>
              <span className="tabular-nums text-gray-500 w-24 text-center">{ym.y} 年 {ym.m + 1} 月</span>
              <button
                onClick={() => setYm(({ y, m }) => (m === 11 ? { y: y + 1, m: 0 } : { y, m: m + 1 }))}
                className="w-5 h-5 rounded text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"
              >›</button>
            </div>
            {/* 只显示周一到周五 */}
            <div className="grid grid-cols-5 gap-1 text-[11px] text-gray-400 mb-1">
              {['一', '二', '三', '四', '五'].map((w) => (
                <div key={w} className="text-center">{w}</div>
              ))}
            </div>
            <div className="grid grid-cols-5 gap-1">
              {calCells.map((dd, i) => {
                if (dd == null) return <div key={`pad${i}`} />;
                const key = `${ym.y}${String(ym.m + 1).padStart(2, '0')}${String(dd).padStart(2, '0')}`;
                const rec = calByDate.get(key);
                const isSel = selDate === key;
                return (
                  <button
                    key={key}
                    disabled={!rec}
                    onClick={() => openDate(key)}
                    title={rec ? `入选 ${rec.n} 只 · 20 日超额 ${pct(rec.ex20)}` : '当日无入选'}
                    className={cn(
                      'h-8 rounded text-[11px] tabular-nums transition border',
                      !rec && 'text-gray-300 dark:text-gray-700 border-transparent cursor-default',
                      rec && !isSel && 'border-gray-200 dark:border-gray-800 text-gray-600 dark:text-gray-300 hover:border-gray-400',
                      isSel && 'border-blue-500 text-blue-600 dark:text-blue-400 font-medium'
                    )}
                  >
                    {dd}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {selDate && (
          <div>
            <div className="text-xs text-gray-500 mb-1.5">入选 {dayPicks?.length ?? 0} 只</div>
            {dayLoading ? (
              <div className="text-xs text-gray-400 py-4 text-center">加载中…</div>
            ) : !dayPicks?.length ? (
              <div className="text-xs text-gray-400 py-4 text-center">当日无入选记录</div>
            ) : (
              <div className="space-y-1.5">
                {dayPicks.map((p) => (
                  <Link
                    key={p.ts_code}
                    href={`/stock/${p.ts_code.split('.')[0]}`}
                    className="block rounded-lg border border-gray-200 dark:border-gray-800 p-2.5 hover:border-gray-300 dark:hover:border-gray-700 transition"
                  >
                    <div className="flex items-center gap-2 text-xs">
                      <span className="w-4 h-4 shrink-0 rounded text-[10px] leading-4 text-center bg-gray-100 dark:bg-gray-800 text-gray-500">{p.rank_no}</span>
                      <span className="font-medium">{p.name || p.ts_code}</span>
                      <span className="text-gray-400">{p.ts_code}</span>
                      <span className="ml-auto text-gray-500">入选时近一月 <span className={tone(p.past20)}>{pct(p.past20, 1)}</span></span>
                    </div>
                    {p.board_name && (
                      <div className="mt-1 text-[11px] text-blue-600 dark:text-blue-400">来自「{p.board_name}」</div>
                    )}
                    {p.llm_thesis && (
                      <div className="mt-1 text-[11px] text-gray-600 dark:text-gray-400">{p.llm_thesis}</div>
                    )}
                    {p.llm_counter && (
                      <div className="mt-0.5 text-[11px] text-gray-500"><span className="text-red-500">🔴 反面：</span>{p.llm_counter}</div>
                    )}
                    <div className="mt-1 flex items-center gap-3 text-[11px] text-gray-500">
                      <span>5 日 <span className={tone(p.ret5)}>{pct(p.ret5)}</span></span>
                      <span>20 日 <span className={tone(p.ret20)}>{pct(p.ret20)}</span></span>
                      <span>20 日超额 <span className={tone(p.ex20)}>{pct(p.ex20)}</span></span>
                      {!p.settled && <span className="text-gray-400">持有中</span>}
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      {/* 整体战绩 */}
      {st && (
        <section>
          <h3 className="text-sm font-medium mb-2">历史战绩</h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Stat label="已定型期数" value={`${st.days}`} sub={`共 ${st.picks} 次入选`} />
            <Stat label="平均 20 日涨跌" value={pct(st.ret20)} tone={st.ret20} />
            <Stat label="平均超额" value={pct(st.ex20)} tone={st.ex20} sub="相对同期市场" />
            <Stat label="20 日胜率" value={st.win20 == null ? '—' : `${(st.win20 * 100).toFixed(1)}%`} />
          </div>
          <div className="mt-2 text-xs text-gray-400">
            数据范围 {st.date_from ? fmtDate(st.date_from) : '—'} ~ {st.date_to ? fmtDate(st.date_to) : '—'}（仅统计已到期样本）
          </div>
        </section>
      )}

      {/* 分年度 */}
      {years.length > 0 && (
        <section>
          <h3 className="text-sm font-medium mb-2">分年度</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-gray-400">
                <tr className="border-b border-gray-100 dark:border-gray-800">
                  <th className="text-left font-normal py-1.5">年份</th>
                  <th className="text-right font-normal py-1.5">期数</th>
                  <th className="text-right font-normal py-1.5">5 日超额</th>
                  <th className="text-right font-normal py-1.5">10 日超额</th>
                  <th className="text-right font-normal py-1.5">20 日超额</th>
                  <th className="text-right font-normal py-1.5">胜率</th>
                </tr>
              </thead>
              <tbody>
                {years.map((y) => (
                  <tr key={y.yr} className="border-b border-gray-50 dark:border-gray-900">
                    <td className="py-1.5">{y.yr}</td>
                    <td className="py-1.5 text-right text-gray-400">{y.days}</td>
                    <td className={cn('py-1.5 text-right', tone(y.ex5))}>{pct(y.ex5)}</td>
                    <td className={cn('py-1.5 text-right', tone(y.ex10))}>{pct(y.ex10)}</td>
                    <td className={cn('py-1.5 text-right', tone(y.ex20))}>{pct(y.ex20)}</td>
                    <td className="py-1.5 text-right text-gray-400">{y.win20 == null ? '—' : `${(y.win20 * 100).toFixed(0)}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* 近期逐期 */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium">近期逐期</h3>
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="text-xs bg-transparent border border-gray-200 dark:border-gray-800 rounded px-2 py-1"
          >
            {[20, 40, 80, 160].map((d) => <option key={d} value={d}>近 {d} 期</option>)}
          </select>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-gray-400">
              <tr className="border-b border-gray-100 dark:border-gray-800">
                <th className="text-left font-normal py-1.5">买入日</th>
                <th className="text-right font-normal py-1.5">入选</th>
                <th className="text-right font-normal py-1.5">5 日</th>
                <th className="text-right font-normal py-1.5">10 日</th>
                <th className="text-right font-normal py-1.5">20 日</th>
                <th className="text-right font-normal py-1.5">20 日超额</th>
              </tr>
            </thead>
            <tbody>
              {hist.map((h) => (
                <tr key={h.pick_date} className="border-b border-gray-50 dark:border-gray-900">
                  <td className="py-1.5">{fmtDate(h.pick_date)}</td>
                  <td className="py-1.5 text-right text-gray-400">{h.n}</td>
                  <td className={cn('py-1.5 text-right', tone(h.ret5))}>{pct(h.ret5)}</td>
                  <td className={cn('py-1.5 text-right', tone(h.ret10))}>{pct(h.ret10)}</td>
                  <td className={cn('py-1.5 text-right', tone(h.ret20))}>{pct(h.ret20)}</td>
                  <td className={cn('py-1.5 text-right', tone(h.ex20))}>{h.settled ? pct(h.ex20) : '持有中'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value, sub, tone: t }: { label: string; value: string; sub?: string; tone?: number | null }) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800 p-2.5">
      <div className="text-[11px] text-gray-400">{label}</div>
      <div className={cn('text-base font-medium mt-0.5', t === undefined ? '' : tone(t))}>{value}</div>
      {sub && <div className="text-[11px] text-gray-400 mt-0.5">{sub}</div>}
    </div>
  );
}

function fmtDate(d: string) {
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}
