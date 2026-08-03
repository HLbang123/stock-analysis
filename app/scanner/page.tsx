'use client';

import { useState, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useStockStore } from '@/store';
import { useScannerStore, type Board } from '@/store/scanner-store';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import { Filter, Loader2, ChevronDown, ChevronUp, Plus, Check, BarChart3, Info } from 'lucide-react';
import { toast } from 'sonner';

const RPS_PERIODS = [
  { value: 20, label: '20日' },
  { value: 60, label: '60日' },
  { value: 120, label: '120日' },
  { value: 250, label: '250日' },
];

const RSI_PERIODS = [
  { value: 6, label: '6日' },
  { value: 12, label: '12日' },
  { value: 24, label: '24日' },
];

const GC_PRESETS = [1, 3, 5];

export default function ScannerPage() {
  const router = useRouter();
  const { addToWatchlist, isInWatchlist } = useStockStore();
  const {
    selectedSectors, setSelectedSectors,
    rpsPeriod, setRpsPeriod,
    rpsMin, setRpsMin,
    rpsIndustry, setRpsIndustry,
    industryLevel, setIndustryLevel,
    rpsResults, setRpsResults,
    filterRps, setFilterRps,
    goldenCross, setGoldenCross,
    gcDays, setGcDays,
    ma55Up, setMa55Up,
    filterRoe, setFilterRoe,
    minRoe, setMinRoe,
    vcp, setVcp,
    filterRsi, setFilterRsi,
    rsiPeriod, setRsiPeriod,
    rsiMin, setRsiMin,
    rsiMax, setRsiMax,
    board, setBoard,
    filterMv, setFilterMv,
    minMv, setMinMv,
  } = useScannerStore();

  // 仅本组件内的瞬态 UI 状态
  const [showSectors, setShowSectors] = useState(true);
  const [showRpsIntro, setShowRpsIntro] = useState(false);
  const [showVcpIntro, setShowVcpIntro] = useState(false);
  const [loading, setLoading] = useState(false);
  const [hasQueried, setHasQueried] = useState(false);

  // 动态行业列表（从 DB 拉，替代硬编码 SECTORS）
  const [industries, setIndustries] = useState<{ name: string; count: number; l2: string[] }[]>([]);

  useEffect(() => {
    fetch('/api/industries').then(r => r.json()).then(d => { if (d.industries) setIndustries(d.industries); }).catch(() => {});
  }, []);

  // 同步选中的板块到 RPS industry
  useEffect(() => {
    if (selectedSectors.length === 1) {
      const industry = selectedSectors[0];
      if (industry !== rpsIndustry) {
        setRpsIndustry(industry);
      }
    }
  }, [selectedSectors, rpsIndustry, setRpsIndustry]);

  const clearSectors = () => {
    setSelectedSectors([]);
    setRpsIndustry('');
    setIndustryLevel('L1');
  };

  // 查询
  const doScan = useCallback(async () => {
    setLoading(true);
    setHasQueried(true);
    try {
      const st = useScannerStore.getState();
      const params = new URLSearchParams({ period: String(st.rpsPeriod), limit: '50' });
      params.set('filterRps', String(st.filterRps));
      if (st.filterRps) params.set('minRps', String(st.rpsMin));
      if (st.rpsIndustry) { params.set('industry', st.rpsIndustry); params.set('industryLevel', st.industryLevel); }
      if (st.goldenCross) { params.set('goldenCross', 'true'); params.set('gcDays', String(st.gcDays)); }
      if (st.ma55Up) params.set('ma55Up', 'true');
      if (st.filterRoe) { params.set('filterRoe', 'true'); params.set('minRoe', String(st.minRoe)); }
      if (st.vcp) params.set('vcp', 'true');
      if (st.filterRsi) {
        params.set('filterRsi', 'true');
        params.set('rsiPeriod', String(st.rsiPeriod));
        if (st.rsiMin != null) params.set('rsiMin', String(st.rsiMin));
        if (st.rsiMax != null) params.set('rsiMax', String(st.rsiMax));
      }
      if (st.filterMv) { params.set('filterMv', 'true'); params.set('minMv', String(st.minMv)); }
      if (st.board !== 'all') params.set('board', st.board);
      const res = await fetch(`/api/scan?${params}`);
      const data = await res.json();
      if (data.error) { toast.error(data.error); st.setRpsResults([]); }
      else if (data.items) st.setRpsResults(data.items);
      else st.setRpsResults([]);
    } catch {
      toast.error('查询失败');
    } finally {
      setLoading(false);
    }
  }, []);

  // Tushare ts_code → 应用格式 (301377.SZ → sz301377)
  const toAppCode = (tsCode: string) => {
    const m = tsCode.match(/^(\d+)\.(SH|SZ|BJ)$/);
    if (!m) return tsCode;
    return m[2].toLowerCase() + m[1];
  };

  const addWatch = (code: string, name: string) => {
    const tsCode = code.replace(/\.(SH|SZ|BJ)$/, '');
    const isSH = tsCode.startsWith('6') || tsCode.startsWith('68');
    const isBJ = tsCode.startsWith('4') || tsCode.startsWith('8') || tsCode.startsWith('9');
    const market = isSH ? 'sh' : isBJ ? 'bj' : 'sz';
    const pureCode = tsCode.replace(/^(sh|sz|bj)/i, '');
    addToWatchlist({ code: `${market}${pureCode}`, name, market, pureCode });
    toast.success(`已添加 ${name}`);
  };

  // 当前查询条件描述
  const condParts: string[] = [];
  if (filterRps) condParts.push(`RPS(${rpsPeriod})≥${rpsMin}`);
  if (goldenCross) condParts.push(gcDays === 0 ? '5/13即将金叉' : `5/13金叉(近${gcDays}日)`);
  if (ma55Up) condParts.push('股价在55日线上方');
  if (filterRoe) condParts.push(`ROE≥${minRoe}%`);
  if (filterMv) condParts.push(`流通市值≥${minMv}亿`);
  if (vcp) condParts.push('VCP收缩');
  if (filterRsi) {
    const lo = rsiMin != null ? `≥${rsiMin}` : '';
    const hi = rsiMax != null ? `≤${rsiMax}` : '';
    const bound = [lo, hi].filter(Boolean).join('且') || '不限';
    condParts.push(`RSI(${rsiPeriod}日)${bound}`);
  }
  const condText = condParts.length > 0 ? condParts.join(' · ') : '无过滤（全市场 top RPS）';

  // 当前选中的 L1（选中 L2 时回溯其父级 L1，用于高亮 + 展开 L2 子目录）
  const activeL1 = !rpsIndustry ? '' :
    industryLevel === 'L1' ? rpsIndustry :
    (industries.find((ind) => ind.l2?.includes(rpsIndustry))?.name ?? '');
  const activeL1Data = industries.find((ind) => ind.name === activeL1);

  return (
    <div>
      <h1 className="text-xl font-bold text-gray-900 dark:text-white mb-4">市场扫描</h1>

      {/* RPS 说明 */}
      <div className="bg-blue-50 dark:bg-blue-950/30 rounded-xl p-3 mb-4 text-sm">
        <button onClick={() => setShowRpsIntro(!showRpsIntro)} className="flex items-center gap-1 text-blue-600 font-medium w-full text-left">
          <Info className="w-4 h-4" /> RPS + 斐波那契均线选股说明
          <span className="text-xs text-blue-400 ml-auto">{showRpsIntro ? '收起' : '展开'}</span>
        </button>
        {showRpsIntro && (
          <div className="mt-2 text-gray-600 dark:text-gray-400 space-y-1 leading-relaxed">
            <p><strong>RPS</strong>：近 N 日涨幅在全市场的百分位排名，≥87 为强势股。5/13/55 是斐波那契数列均线。</p>
            <p>• <strong>5/13金叉</strong>：MA5 上穿 MA13，短期动能转多；选「近 N 日」抓新鲜金叉，「不限」= 当前 MA5&gt;MA13</p>
            <p>• <strong>股价在55日线上方</strong>：当前价格高于55日均线，处于多头区域</p>
            <p>• 三个条件 AND 组合，可自由勾选；不选板块=全市场</p>
          </div>
        )}
      </div>

      {/* VCP 说明 */}
      <div className="bg-purple-50 dark:bg-purple-950/30 rounded-xl p-3 mb-4 text-sm">
        <button onClick={() => setShowVcpIntro(!showVcpIntro)} className="flex items-center gap-1 text-purple-600 font-medium w-full text-left">
          <Info className="w-4 h-4" /> VCP 波动率收缩形态说明
          <span className="text-xs text-purple-400 ml-auto">{showVcpIntro ? '收起' : '展开'}</span>
        </button>
        {showVcpIntro && (
          <div className="mt-2 text-gray-600 dark:text-gray-400 space-y-1 leading-relaxed">
            <p><strong>VCP（Volatility Contraction Pattern）</strong>：Mark Minervini 的趋势延续形态。股价在上升中继里横盘整理，价格摆幅一波比一波小、右侧量能萎缩，卖压枯竭后放量突破。</p>
            <p>• <strong>趋势前置</strong>：价 &gt; MA150 &gt; MA200 且 MA200 上行（只抓第二阶段上升期，过滤熊市假突破）</p>
            <p>• <strong>递进收缩</strong>：近 60 日分三段（各 20 日），每段高低点波幅比上一段收缩 ≥20%</p>
            <p>• <strong>右侧量缩</strong>：最近一段均量 &lt; 上一段 ×0.8</p>
            <p>• <strong>贴近颈线</strong>：最新价 ≥ 底座最高点 ×0.97（即将/刚刚突破）</p>
            <p>• 开启 VCP 会拉长历史窗口至 ~400 日历日以算 MA200，查询比平时略慢；与其他条件 AND 组合</p>
          </div>
        )}
      </div>

      {/* 板块选择器 */}
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm mb-4">
        <button onClick={() => setShowSectors(!showSectors)} className="w-full p-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Filter className="w-5 h-5 text-blue-600" />
            <span className="font-medium">
              行业（{rpsIndustry ? rpsIndustry : '全市场'}）
            </span>
          </div>
          {showSectors ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
        </button>
        {showSectors && (
          <div className="px-4 pb-4">
            <button onClick={clearSectors} className="text-sm text-blue-600 mb-3">清空（全市场）</button>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
              {industries.map((ind) => {
                const isActive = activeL1 === ind.name;
                return (
                  <button key={ind.name} onClick={() => {
                    if (isActive) {
                      // 再次点击当前 L1 → 取消
                      clearSectors();
                    } else {
                      setRpsIndustry(ind.name);
                      setIndustryLevel('L1');
                      setSelectedSectors([ind.name]);
                    }
                  }}
                    className={cn("px-3 py-2 rounded-lg text-sm text-left transition border-2",
                      isActive ? "border-blue-500 bg-blue-50 dark:bg-blue-950" : "border-gray-200 dark:border-gray-700 hover:border-gray-300")}>
                    <div className="font-medium">{ind.name}
                      <span className="text-xs text-gray-400 ml-1">({ind.count})</span>
                    </div>
                    {ind.l2?.length > 0 && (
                      <div className="text-[10px] text-gray-400 mt-0.5 line-clamp-1 leading-tight">
                        {ind.l2.slice(0, 3).join(' · ')}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>

            {/* 选中 L1 后展开的 L2 子目录：可进一步缩到具体 L2，把选择权交给用户 */}
            {activeL1Data && activeL1Data.l2?.length > 0 && (
              <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-800">
                <div className="text-xs text-gray-500 mb-2">在「{activeL1Data.name}」内进一步选二级方向：</div>
                <div className="flex flex-wrap gap-1.5">
                  <button onClick={() => {
                    setRpsIndustry(activeL1Data.name);
                    setIndustryLevel('L1');
                    setSelectedSectors([activeL1Data.name]);
                  }}
                    className={cn("px-2.5 py-1.5 rounded-lg text-xs transition border",
                      industryLevel === 'L1' ? "bg-blue-600 text-white border-blue-600" : "bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:border-blue-300")}>
                    全部{activeL1Data.name}
                  </button>
                  {activeL1Data.l2.map((l2name) => (
                    <button key={l2name} onClick={() => {
                      setRpsIndustry(l2name);
                      setIndustryLevel('L2');
                      setSelectedSectors([l2name]);
                    }}
                      className={cn("px-2.5 py-1.5 rounded-lg text-xs transition border",
                        industryLevel === 'L2' && rpsIndustry === l2name ? "bg-blue-600 text-white border-blue-600" : "bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:border-blue-300")}>
                      {l2name}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 筛选条件 */}
      <Card className="p-4 mb-4">
        <div className="space-y-3">
          {/* RPS */}
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
              <input type="checkbox" checked={filterRps} onChange={e => setFilterRps(e.target.checked)} className="w-4 h-4 rounded accent-blue-600" />
              RPS
            </label>
            {filterRps && (
              <>
                <span className="text-sm text-gray-500">周期</span>
                <div className="flex gap-1">
                  {RPS_PERIODS.map(p => (
                    <button key={p.value} onClick={() => setRpsPeriod(p.value)}
                      className={cn("px-3 py-1.5 rounded-lg text-sm transition",
                        rpsPeriod === p.value ? "bg-blue-600 text-white" : "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200")}>
                      {p.label}
                    </button>
                  ))}
                </div>
                <span className="text-sm text-gray-500">RPS ≥</span>
                <select value={rpsMin} onChange={e => setRpsMin(Number(e.target.value))}
                  className="px-3 py-1.5 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm">
                  {[70, 75, 80, 85, 87, 90, 92, 95, 97, 99].map(n => <option key={n} value={n}>{n}</option>)}
                </select>
              </>
            )}
          </div>

          {/* 5/13金叉 */}
          <div className="flex flex-wrap items-center gap-3">
            <label className={cn("flex items-center gap-2 text-sm font-medium", vcp ? "cursor-not-allowed text-gray-300 dark:text-gray-600" : "cursor-pointer")}>
              <input type="checkbox" checked={goldenCross} disabled={vcp} onChange={e => setGoldenCross(e.target.checked)} className="w-4 h-4 rounded accent-blue-600" />
              5/13金叉
            </label>
            {vcp && <span className="text-xs text-gray-400">VCP 下冲突（收缩期无金叉）</span>}
            {goldenCross && (
              <>
                <span className="text-sm text-gray-500">近</span>
                <div className="flex gap-1">
                  <button onClick={() => setGcDays(0)}
                    className={cn("px-3 py-1.5 rounded-lg text-sm transition",
                      gcDays === 0 ? "bg-blue-600 text-white" : "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200")}>
                    即将金叉
                  </button>
                  {GC_PRESETS.map(d => (
                    <button key={d} onClick={() => setGcDays(d)}
                      className={cn("px-3 py-1.5 rounded-lg text-sm transition",
                        gcDays === d ? "bg-blue-600 text-white" : "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200")}>
                      {d}日
                    </button>
                  ))}
                </div>
                <span className="text-sm text-gray-500">或自定义</span>
                <input type="number" min={1} value={gcDays > 0 ? gcDays : ''} placeholder="N"
                  onChange={e => setGcDays(Math.max(1, Number(e.target.value) || 0))}
                  className="w-16 px-2 py-1.5 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm" />
                <span className="text-sm text-gray-500">日</span>
              </>
            )}
          </div>

          {/* 股价在55日线上方 */}
          <div className="flex flex-wrap items-center gap-3">
            <label className={cn("flex items-center gap-2 text-sm font-medium", vcp ? "cursor-not-allowed text-gray-300 dark:text-gray-600" : "cursor-pointer")} title={vcp ? 'VCP 已含趋势前置（价>MA150>MA200），与本条件冗余' : ''}>
              <input type="checkbox" checked={ma55Up} disabled={vcp} onChange={e => setMa55Up(e.target.checked)} className="w-4 h-4 rounded accent-blue-600" />
              股价在55日线上方
            </label>
            {vcp && <span className="text-xs text-gray-400">VCP 下冗余（趋势前置已含）</span>}
          </div>

          {/* ROE */}
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
              <input type="checkbox" checked={filterRoe} onChange={e => setFilterRoe(e.target.checked)} className="w-4 h-4 rounded accent-blue-600" />
              ROE ≥
            </label>
            {filterRoe && (
              <select value={minRoe} onChange={e => setMinRoe(Number(e.target.value))}
                className="px-3 py-1.5 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm">
                {[5, 8, 10, 12, 15, 20, 25, 30].map(n => <option key={n} value={n}>{n}%</option>)}
              </select>
            )}
          </div>

          {/* 流通市值 */}
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
              <input type="checkbox" checked={filterMv} onChange={e => setFilterMv(e.target.checked)} className="w-4 h-4 rounded accent-blue-600" />
              流通市值 ≥
            </label>
            {filterMv && (
              <>
                <select value={minMv} onChange={e => setMinMv(Number(e.target.value))}
                  className="px-3 py-1.5 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm">
                  {[30, 50, 100, 200, 500, 1000].map(n => <option key={n} value={n}>{n}亿</option>)}
                </select>
                <input type="number" min={0} value={minMv}
                  onChange={e => setMinMv(Math.max(0, Number(e.target.value) || 0))}
                  className="w-20 px-2 py-1.5 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm" />
                <span className="text-sm text-gray-500">亿</span>
                <span className="text-xs text-gray-400">过滤小市值标的</span>
              </>
            )}
          </div>

          {/* RSI */}
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
              <input type="checkbox" checked={filterRsi} onChange={e => setFilterRsi(e.target.checked)} className="w-4 h-4 rounded accent-blue-600" />
              RSI
            </label>
            {filterRsi && (
              <>
                <span className="text-sm text-gray-500">周期</span>
                <div className="flex gap-1">
                  {RSI_PERIODS.map(p => (
                    <button key={p.value} onClick={() => setRsiPeriod(p.value)}
                      className={cn("px-3 py-1.5 rounded-lg text-sm transition",
                        rsiPeriod === p.value ? "bg-blue-600 text-white" : "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200")}>
                      {p.label}
                    </button>
                  ))}
                </div>
                <span className="text-sm text-gray-500">≥</span>
                <input type="number" min={0} max={100} value={rsiMin ?? ''} placeholder="不限"
                  onChange={e => { const v = e.target.value; setRsiMin(v === '' ? null : Math.max(0, Math.min(100, Number(v)))); }}
                  className="w-16 px-2 py-1.5 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm" />
                <span className="text-sm text-gray-500">且 ≤</span>
                <input type="number" min={0} max={100} value={rsiMax ?? ''} placeholder="不限"
                  onChange={e => { const v = e.target.value; setRsiMax(v === '' ? null : Math.max(0, Math.min(100, Number(v)))); }}
                  className="w-16 px-2 py-1.5 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm" />
                <span className="text-xs text-gray-400">如 ≤30 筛超卖、≥70 筛超买；空=不限</span>
              </>
            )}
          </div>

          {/* VCP 波动率收缩 */}
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
              <input type="checkbox" checked={vcp} onChange={e => {
                const on = e.target.checked;
                setVcp(on);
                // VCP 趋势前置已含 MA55 上方；金叉时点与收缩时点互斥——开启 VCP 时清掉这两项
                if (on) { setGoldenCross(false); setMa55Up(false); }
              }} className="w-4 h-4 rounded accent-purple-600" />
              VCP 波动率收缩
            </label>
            <span className="text-xs text-gray-400">趋势前置 + 三段递进收缩 + 右侧量缩 + 贴近颈线（开启后查询略慢，且与5/13金叉、55日线互斥）</span>
          </div>

          {/* 板块过滤 */}
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm font-medium">
              板块
            </label>
            <select value={board} onChange={e => setBoard(e.target.value as Board)}
              className="px-3 py-1.5 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm">
              <option value="all">全部</option>
              <option value="main">主板</option>
              <option value="gem">创业板</option>
              <option value="star">科创板</option>
              <option value="bjse">北交所</option>
            </select>
          </div>
        </div>

        <button onClick={doScan} disabled={loading}
          className="mt-4 w-full py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2">
          {loading && <Loader2 className="w-4 h-4 animate-spin" />}
          {loading ? '查询中...' : '查询'}
        </button>
      </Card>

      {/* 结果表 */}
      {rpsResults.length > 0 && (
        <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm overflow-hidden">
          <div className="p-3 border-b border-gray-100 dark:border-gray-800 text-sm text-gray-500">
            共 {rpsResults.length} 只 · {condText}{rpsIndustry ? ` · ${rpsIndustry}` : ''}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-800 text-left text-xs text-gray-400 uppercase">
                  <th className="px-3 py-2 w-10">#</th>
                  <th className="px-3 py-2">股票</th>
                  <th className="px-3 py-2 text-right">RPS</th>
                  {filterRsi && <th className="px-3 py-2 text-right">RSI</th>}
                  <th className="px-3 py-2 text-right">最新价</th>
                  <th className="px-3 py-2 text-right">日涨跌</th>
                  <th className="px-3 py-2 text-center">信号</th>
                  <th className="px-3 py-2 text-center">操作</th>
                </tr>
              </thead>
              <tbody>
                {rpsResults.map((item, i) => (
                  <tr key={item.tsCode}
                    onClick={() => router.push(`/stock/${toAppCode(item.tsCode)}`)}
                    className={cn("border-b border-gray-50 dark:border-gray-800/50 hover:bg-gray-50 dark:hover:bg-gray-800/30 transition cursor-pointer",
                      (item.rps ?? 0) >= 95 ? "bg-amber-50/30 dark:bg-amber-950/10" : "")}>
                    <td className="px-3 py-2.5 text-gray-400">{i + 1}</td>
                    <td className="px-3 py-2.5">
                      <div className="font-medium">{item.name}</div>
                      <div className="text-gray-400 text-xs">{item.tsCode.replace(/\.(SH|SZ|BJ)$/, '')} · {item.industry || '--'}</div>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {item.rps != null ? (
                        <span className={cn("font-mono font-semibold px-1.5 py-0.5 rounded text-xs",
                          item.rps >= 95 ? "bg-red-100 text-red-700" :
                          item.rps >= 87 ? "bg-orange-100 text-orange-700" :
                          "bg-blue-100 text-blue-700")}>
                          {item.rps.toFixed(1)}
                        </span>
                      ) : '--'}
                    </td>
                    {filterRsi && (
                      <td className="px-3 py-2.5 text-right font-mono">
                        {item.rsi != null ? (
                          <span className={cn("text-xs px-1.5 py-0.5 rounded",
                            item.rsi <= 30 ? "bg-green-100 text-green-700" :
                            item.rsi >= 70 ? "bg-red-100 text-red-700" :
                            "text-gray-500")}>
                            {item.rsi.toFixed(1)}
                          </span>
                        ) : '--'}
                      </td>
                    )}
                    <td className="px-3 py-2.5 text-right font-mono">{item.latestClose != null ? item.latestClose.toFixed(2) : '--'}</td>
                    <td className={cn("px-3 py-2.5 text-right font-mono", (item.latestChange ?? 0) >= 0 ? "text-red-600" : "text-green-600")}>
                      {item.latestChange != null ? `${item.latestChange >= 0 ? '+' : ''}${item.latestChange.toFixed(2)}%` : '--'}
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <div className="flex items-center justify-center gap-1 flex-wrap">
                        {item.gcState && <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded">金叉</span>}
                        {item.ma55Up && <span className="text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">MA55↑</span>}
                        {item.vcp && <span className="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">VCP</span>}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-center" onClick={e => e.stopPropagation()}>
                      {isInWatchlist(item.tsCode.replace(/\.(SH|SZ|BJ)$/, '')) ? (
                        <span className="inline-flex items-center gap-1 px-2 py-1 text-xs text-green-600" title="已在自选中">
                          <Check className="w-3 h-3" /> 已加自选
                        </span>
                      ) : (
                        <button onClick={() => addWatch(item.tsCode, item.name)}
                          className="px-2 py-1 text-xs bg-gray-100 text-gray-500 rounded hover:bg-gray-200 transition">
                          <Plus className="w-3 h-3 inline" /> 加自选
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {loading && rpsResults.length === 0 && (
        <div className="text-center py-16 text-gray-400">
          <Loader2 className="w-8 h-8 mx-auto mb-3 animate-spin" />
          <p className="text-sm">正在扫描全市场，请稍候…</p>
        </div>
      )}

      {!loading && rpsResults.length === 0 && (
        <div className="text-center py-16 text-gray-400">
          <BarChart3 className="w-16 h-16 mx-auto mb-4 opacity-20" />
          {hasQueried ? (
            <>
              <p className="text-lg">没有符合条件的股票</p>
              <p className="text-sm mt-2">试试放宽条件：调低 RPS 阈值、增大金叉天数、或不勾 55日线</p>
            </>
          ) : (
            <>
              <p className="text-lg">勾选条件，点击查询</p>
              <p className="text-sm mt-2">不选板块=全市场，不勾条件=按 RPS 排序</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
