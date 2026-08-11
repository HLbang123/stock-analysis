'use client';

import { useState, useCallback, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useStockStore } from '@/store';
import { useScannerStore, type Board } from '@/store/scanner-store';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { AiScreenTab } from '@/components/AiScreenTab';
import { Filter, Loader2, ChevronDown, ChevronUp, Plus, Check, BarChart3, Search } from 'lucide-react';
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
  const [tab, setTab] = useState<'manual' | 'ai'>('ai');

  return (
    <div>
      <PageHeader title="市场扫描" />
      {/* 顶部 tab：AI 筛选（每日服务器自动跑）为默认，全市场扫描手动查 */}
      <div className="flex gap-1 mb-4 p-1 bg-gray-100 dark:bg-gray-800 rounded-lg w-fit">
        <button
          onClick={() => setTab('ai')}
          className={cn('px-4 py-1.5 rounded-md text-sm transition',
            tab === 'ai' ? 'bg-white dark:bg-gray-900 shadow-sm font-medium' : 'text-gray-500 hover:text-gray-700')}
        >
          AI 筛选
        </button>
        <button
          onClick={() => setTab('manual')}
          className={cn('px-4 py-1.5 rounded-md text-sm transition',
            tab === 'manual' ? 'bg-white dark:bg-gray-900 shadow-sm font-medium' : 'text-gray-500 hover:text-gray-700')}
        >
          全市场扫描
        </button>
      </div>
      {tab === 'ai' ? <AiScreenTab /> : <ManualScan />}
    </div>
  );
}

function ManualScan() {
  const router = useRouter();
  const { addToWatchlist, isInWatchlist, groups, addGroup } = useStockStore();
  const {
    selectedSectors, setSelectedSectors,
    rpsPeriods, setRpsPeriods,
    rpsMin, setRpsMin,
    rpsIndustry, setRpsIndustry,
    industryLevel, setIndustryLevel,
    rpsResults, setRpsResults,
    filterRps, setFilterRps,
    goldenCross, setGoldenCross,
    gcDaysList, setGcDaysList,
    ma55Up, setMa55Up,
    filterRoe, setFilterRoe,
    minRoe, setMinRoe,
    filterRsi, setFilterRsi,
    rsiPeriod, setRsiPeriod,
    rsiMin, setRsiMin,
    rsiMax, setRsiMax,
    board, setBoard,
    filterMv, setFilterMv,
    minMv, setMinMv,
  } = useScannerStore();

  // 仅本组件内的瞬态 UI 状态（板块面板默认折叠，头部常驻显示当前选中行业）
  const [showSectors, setShowSectors] = useState(false);
  const [sectorQuery, setSectorQuery] = useState('');
  // 一键加自选弹层锚点 + 新建分组名；结果排序（null=按接口 RPS 序）
  const [batchMenu, setBatchMenu] = useState<{ x: number; y: number } | null>(null);
  const [newGroupName, setNewGroupName] = useState('');
  const [sortKey, setSortKey] = useState<'rps' | 'close' | 'change' | null>(null);
  const [sortDir, setSortDir] = useState<-1 | 1>(-1);
  const [expandedL1, setExpandedL1] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasQueried, setHasQueried] = useState(false);

  // 动态行业列表（从 DB 拉）：L1 平铺 + L2 手风琴子面板，均带标的数
  const [industries, setIndustries] = useState<{ name: string; count: number; l2: { name: string; count: number }[] }[]>([]);

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
    setExpandedL1(null);
  };

  // 查询
  const doScan = useCallback(async () => {
    setLoading(true);
    setHasQueried(true);
    try {
      const st = useScannerStore.getState();
      const params = new URLSearchParams({ periods: st.rpsPeriods.join(','), limit: '200' });
      params.set('filterRps', String(st.filterRps));
      if (st.filterRps) params.set('minRps', String(st.rpsMin));
      if (st.rpsIndustry) { params.set('industry', st.rpsIndustry); params.set('industryLevel', st.industryLevel); }
      if (st.goldenCross) { params.set('goldenCross', 'true'); params.set('gcDaysList', st.gcDaysList.join(',')); }
      if (st.ma55Up) params.set('ma55Up', 'true');
      if (st.filterRoe) { params.set('filterRoe', 'true'); params.set('minRoe', String(st.minRoe)); }
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

  // ts_code → 自选 Stock 对象
  const toStock = (tsCodeFull: string, name: string) => {
    const tsCode = tsCodeFull.replace(/\.(SH|SZ|BJ)$/, '');
    const isSH = tsCode.startsWith('6') || tsCode.startsWith('68');
    const isBJ = tsCode.startsWith('4') || tsCode.startsWith('8') || tsCode.startsWith('9');
    const market = isSH ? 'sh' : isBJ ? 'bj' : 'sz';
    const pureCode = tsCode.replace(/^(sh|sz|bj)/i, '');
    return { code: `${market}${pureCode}`, name, market, pureCode };
  };

  const addWatch = (code: string, name: string) => {
    addToWatchlist(toStock(code, name));
    toast.success(`已添加 ${name}`);
  };

  // 一键加自选：把当前筛选结果（未在自选的）批量加入指定分组
  const batchAdd = (groupId?: string) => {
    const toAdd = rpsResults.filter((it: any) => !isInWatchlist(toAppCode(it.tsCode)));
    for (const it of toAdd) addToWatchlist(toStock(it.tsCode, it.name), groupId);
    const gName = groupId ? groups.find(g => g.id === groupId)?.name ?? '' : '未分组';
    toast.success(toAdd.length > 0 ? `已添加 ${toAdd.length} 只到「${gName}」` : '全部已在自选中');
    setBatchMenu(null);
  };

  // 临时新建分组并批量加入
  const createGroupAndAdd = () => {
    const name = newGroupName.trim();
    if (!name) return;
    if (!addGroup(name)) { toast.error('分组已存在'); return; }
    const g = useStockStore.getState().groups.find(g => g.name === name);
    setNewGroupName('');
    batchAdd(g?.id);
  };

  // 结果排序：null 保持接口序（RPS 降序）；点击表头切换 key/方向
  const toggleSort = (k: 'rps' | 'close' | 'change') => {
    if (sortKey === k) setSortDir(d => (d === -1 ? 1 : -1));
    else { setSortKey(k); setSortDir(-1); }
  };
  const sortedResults = useMemo(() => {
    if (!sortKey) return rpsResults;
    const val = (it: any): number | null =>
      sortKey === 'rps' ? (it.rpsList?.[0]?.rps ?? it.rps ?? null)
        : sortKey === 'close' ? it.latestClose
        : it.latestChange;
    return [...rpsResults].sort((a, b) => {
      const va = val(a), vb = val(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return (va - vb) * sortDir;
    });
  }, [rpsResults, sortKey, sortDir]);
  const sortMark = (k: string) => (sortKey === k ? (sortDir === -1 ? ' ↓' : ' ↑') : '');

  // 当前查询条件描述
  const condParts: string[] = [];
  if (filterRps) condParts.push(`RPS(${rpsPeriods.join('/')})≥${rpsMin}`);
  if (goldenCross) condParts.push(`5/13金叉(${gcDaysList.map((d) => (d === 0 ? '即将' : `近${d}日`)).join('/')})`);
  if (ma55Up) condParts.push('价格在55日线上方');
  if (filterRoe) condParts.push(`ROE≥${minRoe}%`);
  if (filterMv) condParts.push(`流通市值≥${minMv}亿`);
  if (filterRsi) {
    const lo = rsiMin != null ? `≥${rsiMin}` : '';
    const hi = rsiMax != null ? `≤${rsiMax}` : '';
    const bound = [lo, hi].filter(Boolean).join('且') || '不限';
    condParts.push(`RSI(${rsiPeriod}日)${bound}`);
  }
  const condText = condParts.length > 0 ? condParts.join(' · ') : '无过滤（全市场 top RPS）';

  // 板块选择 = 平铺树（默认只露一级，点选即展开二级手风琴）+ 顶部搜索直达：
  // 有目标的人用搜索，没目标的人逛平铺。搜索时名称子串同时匹配一/二级行业，二级带父级前缀便于区分层级
  const sectorResults = useMemo(() => {
    const q = sectorQuery.trim();
    if (!q) return null;
    return {
      l1: industries.filter((ind) => ind.name.includes(q)),
      l2: industries.flatMap((ind) =>
        (ind.l2 || []).filter((x) => x.name.includes(q)).map((x) => ({ l1: ind.name, name: x.name, count: x.count }))
      ),
    };
  }, [sectorQuery, industries]);

  const pickSector = (name: string, lvl: 'L1' | 'L2') => {
    setRpsIndustry(name);
    setIndustryLevel(lvl);
    setSelectedSectors([name]);
    setSectorQuery(''); // 选中后收起结果列表，当前板块显示在面板标题上
  };

  // 点一级行业 = 选中该行业 + 展开/收起其二级手风琴（合并为一个点击，手机端不用瞄准小箭头）
  const clickL1 = (name: string) => {
    pickSector(name, 'L1');
    setExpandedL1((prev) => (prev === name ? null : name));
  };

  // RPS 周期多选（AND 共振：每个勾选周期都 ≥ 阈值）：至少保留一个
  const toggleRpsPeriod = (v: number) => {
    const next = rpsPeriods.includes(v)
      ? rpsPeriods.filter((p) => p !== v)
      : [...rpsPeriods, v].sort((a, b) => a - b);
    if (next.length > 0) setRpsPeriods(next);
  };

  // 金叉窗口多选（OR 并集：任一窗口命中即可；0=即将金叉）：至少保留一个
  const toggleGcDays = (v: number) => {
    const next = gcDaysList.includes(v)
      ? gcDaysList.filter((d) => d !== v)
      : [...gcDaysList, v];
    if (next.length > 0) setGcDaysList(next.sort((a, b) => a - b));
  };

  // 自定义金叉窗口：列表里非预设的正数项；输入即替换上一个自定义值，清空则移除
  const customGcDay = gcDaysList.find((d) => d > 0 && !GC_PRESETS.includes(d)) ?? null;
  const onCustomGcDays = (raw: string) => {
    setGcDaysList((prev) => {
      const base = prev.filter((d) => d === 0 || GC_PRESETS.includes(d));
      const n = Math.floor(Number(raw) || 0);
      const next = raw === '' || n < 1 ? base : [...new Set([...base, n])];
      return (next.length > 0 ? next : [5]).sort((a, b) => a - b);
    });
  };

  const expandedL1Info = expandedL1 ? industries.find((i) => i.name === expandedL1) : undefined;

  return (
    <div>
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
            <div className="flex items-center gap-3">
              <div className="relative flex-1 max-w-xs">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
                <input
                  value={sectorQuery}
                  onChange={(e) => setSectorQuery(e.target.value)}
                  placeholder="搜索行业直达，如：半导体"
                  className="w-full pl-8 pr-3 py-1.5 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm"
                />
              </div>
              {rpsIndustry && (
                <button onClick={clearSectors} className="text-sm text-blue-600 shrink-0">清空（全市场）</button>
              )}
            </div>

            {sectorResults ? (
              /* 搜索态：一/二级行业匹配项，二级带父级前缀 */
              <div className="flex flex-wrap gap-1.5 mt-3">
                {sectorResults.l1.map((ind) => (
                  <button key={`s-l1-${ind.name}`} onClick={() => pickSector(ind.name, 'L1')}
                    className={cn("px-2.5 py-1.5 rounded-lg text-xs transition border",
                      industryLevel === 'L1' && rpsIndustry === ind.name
                        ? "bg-blue-600 text-white border-blue-600"
                        : "bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:border-blue-300")}>
                    {ind.name}
                    <span className="opacity-60 ml-1">一级 · {ind.count}</span>
                  </button>
                ))}
                {sectorResults.l2.map((item) => (
                  <button key={`s-l2-${item.l1}-${item.name}`} onClick={() => pickSector(item.name, 'L2')}
                    className={cn("px-2.5 py-1.5 rounded-lg text-xs transition border",
                      industryLevel === 'L2' && rpsIndustry === item.name
                        ? "bg-blue-600 text-white border-blue-600"
                        : "bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:border-blue-300")}>
                    <span className="opacity-60">{item.l1} / </span>{item.name}
                    <span className="opacity-60 ml-1">{item.count}</span>
                  </button>
                ))}
                {sectorResults.l1.length === 0 && sectorResults.l2.length === 0 && (
                  <p className="text-xs text-gray-400 py-1">无匹配行业，换个关键词试试</p>
                )}
              </div>
            ) : (
              /* 浏览态：一级行业平铺（点选即选中并展开二级手风琴，再点收起） */
              <>
                <div className="flex flex-wrap gap-1.5 mt-3">
                  {industries.map((ind) => {
                    const isSelected = industryLevel === 'L1' && rpsIndustry === ind.name;
                    const isExpanded = expandedL1 === ind.name;
                    return (
                      <button key={ind.name} onClick={() => clickL1(ind.name)}
                        className={cn("px-2.5 py-1.5 rounded-lg text-xs transition border inline-flex items-center",
                          isSelected
                            ? "bg-blue-600 text-white border-blue-600"
                            : isExpanded
                              ? "border-blue-400 text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/30"
                              : "bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:border-blue-300")}>
                        {ind.name}
                        <span className="opacity-60 ml-1">{ind.count}</span>
                        {ind.l2.length > 0 && (
                          <ChevronDown className={cn("w-3 h-3 ml-0.5 opacity-60 transition-transform", isExpanded && "rotate-180")} />
                        )}
                      </button>
                    );
                  })}
                </div>
                {expandedL1 && expandedL1Info && (
                  /* 二级手风琴子面板：贴在 L1 网格下方，面包屑式标题 */
                  <div className="mt-2 rounded-lg border border-blue-100 dark:border-blue-900/50 bg-blue-50/50 dark:bg-blue-950/20 p-2.5">
                    <div className="flex items-center justify-between px-0.5 pb-2">
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        <span className="text-blue-600 dark:text-blue-400">{expandedL1}</span> › 二级行业
                      </span>
                      <button onClick={() => setExpandedL1(null)} className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">收起</button>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {expandedL1Info.l2.map((item) => (
                        <button key={item.name} onClick={() => pickSector(item.name, 'L2')}
                          className={cn("px-2.5 py-1.5 rounded-lg text-xs transition border",
                            industryLevel === 'L2' && rpsIndustry === item.name
                              ? "bg-blue-600 text-white border-blue-600"
                              : "bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:border-blue-300")}>
                          {item.name}
                          <span className="opacity-60 ml-1">{item.count}</span>
                        </button>
                      ))}
                      {expandedL1Info.l2.length === 0 && (
                        <p className="text-xs text-gray-400 py-1">该行业暂无二级分类</p>
                      )}
                    </div>
                  </div>
                )}
              </>
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
                    <button key={p.value} onClick={() => toggleRpsPeriod(p.value)}
                      className={cn("px-3 py-1.5 rounded-lg text-sm transition",
                        rpsPeriods.includes(p.value) ? "bg-blue-600 text-white" : "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200")}>
                      {p.label}
                    </button>
                  ))}
                </div>
                <span className="text-sm text-gray-500">RPS ≥</span>
                <select value={rpsMin} onChange={e => setRpsMin(Number(e.target.value))}
                  className="px-3 py-1.5 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm">
                  {[70, 75, 80, 85, 87, 90, 92, 95, 97, 99].map(n => <option key={n} value={n}>{n}</option>)}
                </select>
                <span className="text-xs text-gray-400">可多选</span>
              </>
            )}
          </div>

          {/* 5/13金叉 */}
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
              <input type="checkbox" checked={goldenCross} onChange={e => setGoldenCross(e.target.checked)} className="w-4 h-4 rounded accent-blue-600" />
              5/13金叉
            </label>
            {goldenCross && (
              <>
                <div className="flex gap-1">
                  <button onClick={() => toggleGcDays(0)}
                    className={cn("px-3 py-1.5 rounded-lg text-sm transition",
                      gcDaysList.includes(0) ? "bg-blue-600 text-white" : "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200")}>
                    即将金叉
                  </button>
                  {GC_PRESETS.map(d => (
                    <button key={d} onClick={() => toggleGcDays(d)}
                      className={cn("px-3 py-1.5 rounded-lg text-sm transition",
                        gcDaysList.includes(d) ? "bg-blue-600 text-white" : "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200")}>
                      近{d}日
                    </button>
                  ))}
                </div>
                <span className="text-sm text-gray-500">或自定义</span>
                <input type="number" min={1} value={customGcDay ?? ''} placeholder="N"
                  onChange={e => onCustomGcDays(e.target.value)}
                  className="w-16 px-2 py-1.5 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm" />
                <span className="text-sm text-gray-500">日</span>
                <span className="text-xs text-gray-400">可多选，任一窗口命中即可</span>
              </>
            )}
          </div>

          {/* 股价在55日线上方 */}
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
              <input type="checkbox" checked={ma55Up} onChange={e => setMa55Up(e.target.checked)} className="w-4 h-4 rounded accent-blue-600" />
              股价在55日线上方
            </label>
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
                <span className="text-xs text-gray-400">空=不限</span>
              </>
            )}
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
                  <th className="px-3 py-2">标的</th>
                  <th className="px-3 py-2 text-right cursor-pointer select-none hover:text-gray-600 dark:hover:text-gray-200" onClick={() => toggleSort('rps')}>RPS{sortMark('rps')}</th>
                  {filterRsi && <th className="px-3 py-2 text-right">RSI</th>}
                  <th className="px-3 py-2 text-right cursor-pointer select-none hover:text-gray-600 dark:hover:text-gray-200" onClick={() => toggleSort('close')}>最新价{sortMark('close')}</th>
                  <th className="px-3 py-2 text-right cursor-pointer select-none hover:text-gray-600 dark:hover:text-gray-200" onClick={() => toggleSort('change')}>日涨跌{sortMark('change')}</th>
                  <th className="px-3 py-2 text-center">信号</th>
                  <th className="px-3 py-2 text-center normal-case whitespace-nowrap">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        const r = e.currentTarget.getBoundingClientRect();
                        setBatchMenu(m => (m ? null : { x: r.right, y: r.bottom }));
                      }}
                      className="inline-flex items-center gap-0.5 px-2 py-1 text-xs bg-blue-600 text-white rounded-md hover:bg-blue-700 transition whitespace-nowrap"
                    >
                      全 <Plus className="w-3 h-3" />
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedResults.map((item) => (
                  <tr key={item.tsCode}
                    onClick={() => router.push(`/stock/${toAppCode(item.tsCode)}`)}
                    className={cn("border-b border-gray-50 dark:border-gray-800/50 hover:bg-gray-50 dark:hover:bg-gray-800/30 transition cursor-pointer",
                      (item.rps ?? 0) >= 95 ? "bg-amber-50/30 dark:bg-amber-950/10" : "")}>
                    <td className="px-3 py-2.5">
                      <div className="font-medium">{item.name}</div>
                      <div className="text-gray-400 text-xs">{item.tsCode.replace(/\.(SH|SZ|BJ)$/, '')} · {item.industry || '--'}</div>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {/* 多周期分行展示；旧持久化结果无 rpsList 时回退单值 */}
                      {(item.rpsList && item.rpsList.length > 0 ? item.rpsList : [{ period: 0, rps: item.rps }]).map((p, _i, arr) => (
                        <div key={p.period || 'legacy'} className="flex items-center justify-end gap-1">
                          {arr.length > 1 && <span className="text-[10px] text-gray-400">{p.period}日</span>}
                          {p.rps != null ? (
                            <span className={cn("font-mono font-semibold px-1.5 py-0.5 rounded text-xs",
                              p.rps >= 95 ? "bg-red-100 text-red-700" :
                              p.rps >= 87 ? "bg-orange-100 text-orange-700" :
                              "bg-blue-100 text-blue-700")}>
                              {p.rps.toFixed(1)}
                            </span>
                          ) : '--'}
                        </div>
                      ))}
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
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-center" onClick={e => e.stopPropagation()}>
                      {isInWatchlist(toAppCode(item.tsCode)) ? (
                        <span className="inline-flex p-1.5 text-[var(--color-down)]" title="已在自选中">
                          <Check className="w-4 h-4" />
                        </span>
                      ) : (
                        <button onClick={() => addWatch(item.tsCode, item.name)}
                          className="inline-flex p-1.5 bg-[var(--color-accent-soft)] text-[var(--color-accent)] rounded-[var(--radius-md)] hover:opacity-80 transition"
                          title="加自选">
                          <Plus className="w-4 h-4" />
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

      {/* 一键加自选：分组选择弹层（fixed 定位，锚在表头按钮下方） */}
      {batchMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setBatchMenu(null)} />
          <div
            className="fixed z-50 w-48 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-lg p-1.5 text-sm"
            style={{ left: Math.max(8, batchMenu.x - 192), top: batchMenu.y + 4 }}
          >
            <div className="px-2 py-1 text-xs text-gray-400">全部添加到分组</div>
            <button onClick={() => batchAdd(undefined)} className="w-full text-left px-2 py-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition">
              未分组
            </button>
            {groups.map(g => (
              <button key={g.id} onClick={() => batchAdd(g.id)} className="w-full text-left px-2 py-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition">
                {g.name}
              </button>
            ))}
            <div className="mt-1 pt-1.5 border-t border-gray-100 dark:border-gray-800 flex gap-1">
              <input
                value={newGroupName}
                onChange={e => setNewGroupName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && createGroupAndAdd()}
                placeholder="新建分组"
                className="flex-1 min-w-0 px-2 py-1 text-xs border border-gray-200 dark:border-gray-700 rounded bg-transparent"
              />
              <button onClick={createGroupAndAdd} className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 transition">
                确定
              </button>
            </div>
          </div>
        </>
      )}

      {!loading && rpsResults.length === 0 && (
        <div className="text-center py-16 text-gray-400">
          <BarChart3 className="w-16 h-16 mx-auto mb-4 opacity-20" />
          {hasQueried ? (
            <>
              <p className="text-lg">没有符合条件的标的</p>
              <p className="text-sm mt-2">试试放宽条件：调低 RPS 阈值、增大金叉天数、或不勾 55日线</p>
            </>
          ) : (
            <>
              <p className="text-lg">勾选条件，点击查询</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
