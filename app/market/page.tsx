'use client';

import { useState, useEffect, useCallback } from 'react';
import { EChart } from '@/components/market/EChart';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { LineChart, Loader2 } from 'lucide-react';

const IDX_OPTIONS = [
  { code: '000001.SH', name: '上证综指' },
  { code: '399001.SZ', name: '深证成指' },
  { code: '399006.SZ', name: '创业板指' },
  { code: '000016.SH', name: '上证50' },
  { code: '000905.SH', name: '中证500' },
  { code: '000300.SH', name: '沪深300' },
];

const md = (d: string) => d ? `${d.slice(4, 6)}-${d.slice(6, 8)}` : '';
const yi = (wan: number | null) => (wan == null ? null : Number((wan / 10000).toFixed(2))); // 万元→亿
const yi2 = (yuan: number | null) => (yuan == null ? null : Number((yuan / 1e8).toFixed(2))); // 元→亿

export default function MarketPage() {
  const [breadth, setBreadth] = useState<any[]>([]);
  const [northbound, setNorthbound] = useState<any[]>([]);
  const [margin, setMargin] = useState<any[]>([]);
  const [sectors, setSectors] = useState<any[]>([]);
  const [idxCode, setIdxCode] = useState('000001.SH');
  const [idxVal, setIdxVal] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [limitUp, setLimitUp] = useState<any>(null);
  const [hotStocks, setHotStocks] = useState<any>(null);
  const [sectorFlow, setSectorFlow] = useState<any[]>([]);
  const [sectorIndex, setSectorIndex] = useState<any[]>([]);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [b, n, m, s, lu, hs, sf, si] = await Promise.all([
        fetch('/api/market/breadth?days=60').then(r => r.json()),
        fetch('/api/market/northbound?days=120').then(r => r.json()),
        fetch('/api/market/margin?days=120').then(r => r.json()),
        fetch('/api/rps/sectors?period=250&min=87').then(r => r.json()),
        fetch('/api/limit-up').then(r => r.ok ? r.json() : null).catch(() => null),
        fetch('/api/fuyao/hot-stocks').then(r => r.ok ? r.json() : null).catch(() => null),
        fetch('/api/market/sector-flow?days=5').then(r => r.json()).catch(() => null),
        fetch('/api/market/sector-index?days=1').then(r => r.json()).catch(() => null),
      ]);
      if (b.items) setBreadth(b.items);
      if (n.items) setNorthbound(n.items);
      if (m.items) setMargin(m.items);
      if (s.sectors) setSectors(s.sectors);
      if (lu && !lu.error) setLimitUp(lu);
      if (hs && !hs.error) setHotStocks(hs);
      if (sf?.sectors) setSectorFlow(sf.sectors);
      if (si?.sectors) setSectorIndex(si.sectors);
    } catch { /* ignore */ } finally { setLoading(false); }
  }, []);

  const fetchIdx = useCallback(async (code: string) => {
    try {
      const r = await fetch(`/api/market/index-valuation?ts_code=${code}`).then(r => r.json());
      setIdxVal(r);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);
  useEffect(() => { fetchIdx(idxCode); }, [idxCode, fetchIdx]);

  const latest = breadth[breadth.length - 1];
  const dates = breadth.map(b => md(b.date));

  return (
    <div>
      <h1 className="text-xl font-bold text-gray-900 dark:text-white mb-1 flex items-center gap-2">
        <LineChart className="w-6 h-6 text-blue-500" /> 大盘
      </h1>
      <p className="text-xs text-gray-400 mb-4">
        数据日期：{latest?.date || '--'} · 市场级宏观温度，辅助判断仓位轻重
      </p>

      {loading && (
        <div className="flex items-center justify-center py-20 text-gray-400">
          <Loader2 className="w-6 h-6 animate-spin mr-2" /> 加载中...
        </div>
      )}

      {!loading && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* 1. 市场宽度温度计 */}
          <Card className="p-4">
            <h3 className="font-medium mb-1">市场宽度温度计</h3>
            {latest && (
              <p className="text-xs text-gray-500 mb-2">
                涨<b className="text-red-600">{latest.advance}</b> 跌<b className="text-green-600">{latest.decline}</b>
                {' '}平{latest.flat} · 涨停<b className="text-red-600">{latest.limitUp}</b> 跌停<b className="text-green-600">{latest.limitDown}</b>
                {' '}· 20日新高{latest.newHigh20} 新低{latest.newLow20}
              </p>
            )}
            <div className="h-56">
              {breadth.length > 0 ? (
                <EChart option={{
                  tooltip: { trigger: 'axis' },
                  legend: { data: ['上涨', '下跌'], top: 0 },
                  grid: { left: 40, right: 15, top: 25, bottom: 25 },
                  xAxis: { type: 'category', data: dates, axisLabel: { fontSize: 10 } },
                  yAxis: { type: 'value' },
                  series: [
                    { name: '上涨', type: 'bar', data: breadth.map(b => b.advance), itemStyle: { color: '#ef4444' } },
                    { name: '下跌', type: 'bar', data: breadth.map(b => b.decline ? -b.decline : 0), itemStyle: { color: '#22c55e' } },
                  ],
                }} />
              ) : <Empty />}
            </div>
          </Card>

          {/* 2. 大势温度 */}
          <Card className="p-4">
            <h3 className="font-medium mb-1">大势温度（多头占比）</h3>
            <p className="text-xs text-gray-500 mb-2">MA55 上方占比 & RPS≥87 强势股占比（%）</p>
            <div className="h-56">
              {breadth.length > 0 ? (
                <EChart option={{
                  tooltip: { trigger: 'axis', valueFormatter: (v: any) => v + '%' },
                  legend: { data: ['MA55上方', 'RPS≥87'], top: 0 },
                  grid: { left: 40, right: 15, top: 25, bottom: 25 },
                  xAxis: { type: 'category', data: dates, axisLabel: { fontSize: 10 } },
                  yAxis: { type: 'value', max: 100 },
                  series: [
                    { name: 'MA55上方', type: 'line', data: breadth.map(b => b.aboveMa55Ratio), smooth: true, markLine: { silent: true, lineStyle: { type: 'dashed' }, data: [{ yAxis: 50 }, { yAxis: 30 }] } },
                    { name: 'RPS≥87', type: 'line', data: breadth.map(b => b.strongRpsRatio), smooth: true },
                  ],
                }} />
              ) : <Empty />}
            </div>
          </Card>

          {/* 3. 行业强度榜 */}
          <Card className="p-4">
            <h3 className="font-medium mb-1">行业强度榜（RPS≥87 占比 %）</h3>
            <p className="text-xs text-gray-500 mb-2">资金在哪个方向</p>
            <div className="h-72">
              {sectors.length > 0 ? (
                <EChart option={{
                  tooltip: { formatter: '{b}: {c}%' },
                  grid: { left: 90, right: 30, top: 10, bottom: 20 },
                  xAxis: { type: 'value', max: 80 },
                  yAxis: { type: 'category', data: sectors.slice(0, 20).map(s => s.industry), inverse: true, axisLabel: { fontSize: 10 } },
                  series: [{ type: 'bar', data: sectors.slice(0, 20).map(s => s.ratio), itemStyle: { color: '#3b82f6' } }],
                }} />
              ) : <Empty />}
            </div>
          </Card>

          {/* 板块资金流向（近5日主力净流入排行） */}
          <Card className="p-4">
            <h3 className="font-medium mb-1">板块资金流向（近5日主力净流入）</h3>
            <p className="text-xs text-gray-500 mb-2">红色=净流入，绿色=净流出（亿元）</p>
            {sectorFlow.length > 0 ? (
              <div className="h-72 overflow-y-auto space-y-0.5">
                {sectorFlow.slice(0, 30).map((s) => {
                  const yi = s.totalNet != null ? Number(s.totalNet) / 10000 : null;
                  return (
                    <div key={s.industry} className="flex items-center gap-2 text-xs py-0.5">
                      <span className="w-20 truncate text-gray-600 dark:text-gray-400 shrink-0">{s.industry}</span>
                      <div className="flex-1 bg-gray-100 dark:bg-gray-800 rounded h-4 relative overflow-hidden">
                        {yi != null && yi >= 0 && (
                          <div className="absolute left-1/2 top-0 h-full bg-red-200 dark:bg-red-900/50"
                            style={{ width: `${Math.min(Math.abs(yi) / 50 * 100, 50)}%` }} />
                        )}
                        {yi != null && yi < 0 && (
                          <div className="absolute right-1/2 top-0 h-full bg-green-200 dark:bg-green-900/50"
                            style={{ width: `${Math.min(Math.abs(yi) / 50 * 100, 50)}%` }} />
                        )}
                        <div className="absolute left-1/2 top-0 w-px h-full bg-gray-300 dark:bg-gray-600" />
                      </div>
                      <span className={cn("w-14 text-right font-mono shrink-0",
                        yi != null && yi >= 0 ? "text-red-600" : "text-green-600")}>
                        {yi != null ? `${yi >= 0 ? '+' : ''}${yi.toFixed(1)}` : '--'}
                      </span>
                      <span className="text-xs text-gray-400 shrink-0">{s.stockCount}只</span>
                    </div>
                  );
                })}
              </div>
            ) : <Empty />}
          </Card>

          {/* 4. 指数估值分位 */}
          <Card className="p-4">
            <div className="flex items-center justify-between mb-1">
              <h3 className="font-medium">指数估值历史分位</h3>
              <select value={idxCode} onChange={e => setIdxCode(e.target.value)}
                className="px-2 py-1 border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-800 text-xs">
                {IDX_OPTIONS.map(o => <option key={o.code} value={o.code}>{o.name}</option>)}
              </select>
            </div>
            <p className="text-xs text-gray-500 mb-2">
              {idxVal?.name} · PE-TTM {idxVal?.currentPeTtm ?? '--'} · PB {idxVal?.currentPb ?? '--'} · 分位 <b className={idxVal?.percentile >= 70 ? 'text-red-600' : idxVal?.percentile <= 30 ? 'text-green-600' : ''}>{idxVal?.percentile ?? '--'}%</b>
            </p>
            <div className="h-56">
              {idxVal?.history?.length > 0 ? (
                <EChart option={{
                  tooltip: { trigger: 'axis' },
                  grid: { left: 40, right: 15, top: 15, bottom: 25 },
                  xAxis: { type: 'category', data: idxVal.history.map((h: any) => md(h.date)), axisLabel: { fontSize: 10 } },
                  yAxis: { type: 'value', scale: true },
                  series: [{ type: 'line', data: idxVal.history.map((h: any) => h.pe), smooth: true, showSymbol: false, lineStyle: { width: 1.5 } }],
                }} />
              ) : <Empty />}
            </div>
          </Card>

          {/* 5. 北向资金 */}
          <Card className="p-4">
            <h3 className="font-medium mb-1">北向资金（亿元）</h3>
            <p className="text-xs text-gray-500 mb-2">日净流入（柱）+ 累计余额（线）</p>
            <div className="h-56">
              {northbound.length > 0 ? (
                <EChart option={{
                  tooltip: { trigger: 'axis' },
                  legend: { data: ['日净流入', '累计余额'], top: 0 },
                  grid: { left: 45, right: 45, top: 25, bottom: 25 },
                  xAxis: { type: 'category', data: northbound.map(n => md(n.date)), axisLabel: { fontSize: 10 } },
                  yAxis: [{ type: 'value', name: '净流入', scale: true }, { type: 'value', name: '累计', scale: true }],
                  series: [
                    { name: '日净流入', type: 'bar', data: northbound.map(n => yi(n.northMoney)), itemStyle: { color: (p: any) => (p.value >= 0 ? '#ef4444' : '#22c55e') } },
                    { name: '累计余额', type: 'line', yAxisIndex: 1, data: northbound.map(n => yi(n.northTotal)), smooth: true, showSymbol: false },
                  ],
                }} />
              ) : <Empty />}
            </div>
          </Card>

          {/* 6. 融资融券 */}
          <Card className="p-4">
            <h3 className="font-medium mb-1">融资融券（亿元）</h3>
            <p className="text-xs text-gray-500 mb-2">融资余额（线）+ 净变化（柱）</p>
            <div className="h-56">
              {margin.length > 0 ? (
                <EChart option={{
                  tooltip: { trigger: 'axis' },
                  legend: { data: ['融资余额', '净变化'], top: 0 },
                  grid: { left: 45, right: 45, top: 25, bottom: 25 },
                  xAxis: { type: 'category', data: margin.map(m => md(m.date)), axisLabel: { fontSize: 10 } },
                  yAxis: [{ type: 'value', name: '余额', scale: true }, { type: 'value', name: '净变化', scale: true }],
                  series: [
                    { name: '融资余额', type: 'line', data: margin.map(m => yi2(m.rzye)), smooth: true, showSymbol: false },
                    { name: '净变化', type: 'bar', yAxisIndex: 1, data: margin.map(m => yi2(m.netChange)), itemStyle: { color: (p: any) => (p.value >= 0 ? '#ef4444' : '#22c55e') } },
                  ],
                }} />
              ) : <Empty />}
            </div>
          </Card>

          {/* 7. 涨停情绪（Tushare limit_list_d） */}
          <Card className="p-4">
            <h3 className="font-medium mb-1">涨停情绪</h3>
            {limitUp?.items?.up?.length > 0 ? (
              <>
                <p className="text-xs text-gray-500 mb-2">
                  今日涨停 <b className="text-red-600">{limitUp.count.up}</b> 只
                  · 跌停 <b className="text-green-600">{limitUp.count.down}</b> 只
                  {limitUp.count.broken > 0 && <span className="text-gray-400"> · 炸板 {limitUp.count.broken}</span>}
                </p>
                <div className="space-y-1 max-h-48 overflow-y-auto">
                  {limitUp.items.up.slice(0, 15).map((s: any) => (
                    <div key={s.tsCode} className="flex items-center gap-2 text-xs py-1 border-b border-gray-50 dark:border-gray-800/50">
                      <span className={cn("px-1.5 py-0.5 rounded font-medium shrink-0",
                        s.limitTimes >= 3 ? "bg-red-100 text-red-700" : "bg-orange-100 text-orange-700")}>
                        {s.limitTimes}板
                      </span>
                      <span className="font-medium shrink-0">{s.name}</span>
                      <span className="text-gray-400 shrink-0">{s.firstTime}</span>
                      {s.openTimes > 0 && <span className="text-orange-500 shrink-0">炸{s.openTimes}次</span>}
                      {s.fdAmount != null && <span className="text-gray-400 shrink-0">封单{(s.fdAmount / 1e4).toFixed(0)}万</span>}
                      <span className="text-gray-500 truncate">{s.upStat}</span>
                    </div>
                  ))}
                  {limitUp.items.up.length > 15 && <p className="text-xs text-gray-400 pt-1">还有 {limitUp.items.up.length - 15} 只...</p>}
                </div>
              </>
            ) : <Empty />}
          </Card>

          {/* 行业指数涨跌幅排行 */}
          <Card className="p-4">
            <h3 className="font-medium mb-1">行业涨跌幅排行</h3>
            <p className="text-xs text-gray-500 mb-2">申万一级行业指数（当日涨跌幅）</p>
            {sectorIndex.length > 0 ? (
              <div className="h-56 overflow-y-auto space-y-0.5">
                {sectorIndex.slice(0, 25).map((s) => {
                  const pct = s.latestPctChg;
                  const name = s.tsCode.replace(/\.SI$/, '');
                  return (
                    <div key={s.tsCode} className="flex items-center gap-2 text-xs py-0.5">
                      <span className="w-20 truncate text-gray-600 dark:text-gray-400 shrink-0">{name}</span>
                      <div className="flex-1 h-4 relative">
                        <div className="absolute left-1/2 top-0 w-px h-full bg-gray-300 dark:bg-gray-600" />
                        {pct != null && pct >= 0 && (
                          <div className="absolute left-1/2 top-0 h-full bg-red-200 dark:bg-red-900/50"
                            style={{ width: `${Math.min(Math.abs(pct) * 8, 48)}%` }} />
                        )}
                        {pct != null && pct < 0 && (
                          <div className="absolute right-1/2 top-0 h-full bg-green-200 dark:bg-green-900/50"
                            style={{ width: `${Math.min(Math.abs(pct) * 8, 48)}%` }} />
                        )}
                      </div>
                      <span className={cn("w-12 text-right font-mono shrink-0",
                        pct != null && pct >= 0 ? "text-red-600" : "text-green-600")}>
                        {pct != null ? `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%` : '--'}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : <Empty />}
          </Card>

          {/* 8. 热度排行 */}
          <Card className="p-4">
            <h3 className="font-medium mb-1">热度排行</h3>
            {hotStocks?.hot?.item?.length > 0 ? (
              <>
                <p className="text-xs text-gray-500 mb-2">热股 Top10（24h）</p>
                <div className="space-y-1 mb-3">
                  {hotStocks.hot.item.slice(0, 10).map((s: any) => (
                    <div key={s.thscode} className="flex items-center gap-2 text-xs py-0.5">
                      <span className={cn("w-5 text-center font-bold shrink-0",
                        s.rank <= 3 ? "text-red-500" : "text-gray-400")}>{s.rank}</span>
                      <span className="font-medium shrink-0">{s.name}</span>
                      <span className={cn("text-xs shrink-0",
                        s.rank_trend === 'up' ? "text-red-500" : s.rank_trend === 'down' ? "text-green-500" : "text-gray-400")}>
                        {s.rank_trend === 'up' ? '↑' : s.rank_trend === 'down' ? '↓' : '—'}
                        {s.rank_change !== 0 && Math.abs(s.rank_change)}
                      </span>
                      <span className="text-gray-400 ml-auto">{(Number(s.heat) / 10000).toFixed(0)}万</span>
                    </div>
                  ))}
                </div>
                {hotStocks?.skyrocket?.item?.length > 0 && (
                  <>
                    <p className="text-xs text-gray-500 mb-1 mt-3">飙升 Top5（1h）</p>
                    <div className="space-y-1">
                      {hotStocks.skyrocket.item.slice(0, 5).map((s: any) => (
                        <div key={s.thscode} className="flex items-center gap-2 text-xs py-0.5">
                          <span className="w-5 text-center font-bold text-orange-500 shrink-0">{s.rank}</span>
                          <span className="font-medium shrink-0">{s.name}</span>
                          <span className="text-orange-500 shrink-0">↑{s.rank_change}</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </>
            ) : <Empty />}
          </Card>
        </div>
      )}
    </div>
  );
}

function Empty() {
  return (
    <div className="h-full flex items-center justify-center text-xs text-gray-400">
      数据未生成，请在服务器运行 run-daily
    </div>
  );
}
