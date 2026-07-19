'use client';

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useStockStore } from '@/store';
import { getRealtimeQuote, getKLineSina } from '@/services/stockApi';
import { ALERT_RULES, checkAllRules } from '@/services/alertRules';
import { SECTORS } from '@/lib/sectors';
import { cn } from '@/lib/utils';
import { buildUpdatedKLines } from '@/lib/stock-helpers';
import { Card } from '@/components/ui/card';
import { Search, TrendingUp, Filter, Loader2, Zap, ChevronDown, ChevronUp, Plus, BarChart3, ExternalLink, Info } from 'lucide-react';
import { toast } from 'sonner';

interface ScanResult {
  code: string;
  name: string;
  quote: any;
  alerts: any[];
  alertCount: number;
  isNew?: boolean;
}

interface RpsItem {
  tsCode: string;
  name: string;
  industry: string;
  rps: number;
  ret: number;
  latestClose: number;
  latestChange: number;
  latestVol: number;
}

const SCAN_RULES = ALERT_RULES.filter(r =>
  ['R001', 'R003', 'R006', 'R011', 'R012', 'R013', 'R014', 'R015', 'R016', 'R017'].includes(r.id)
);

const RPS_PERIODS = [
  { value: 20, label: '20日' },
  { value: 60, label: '60日' },
  { value: 120, label: '120日' },
  { value: 250, label: '250日' },
];

type ScanMode = 'rules' | 'rps';

export default function ScannerPage() {
  const router = useRouter();
  const { addToWatchlist, isInWatchlist } = useStockStore();

  // localStorage 读写
  const getStored = (key: string, fallback: string) => {
    if (typeof window === 'undefined') return fallback;
    return localStorage.getItem(`scanner_${key}`) || fallback;
  };
  const setStored = (key: string, val: string) => {
    if (typeof window !== 'undefined') localStorage.setItem(`scanner_${key}`, val);
  };

  // 通用
  const [mode, setMode] = useState<ScanMode>('rps');
  const [selectedSectors, setSelectedSectors] = useState<Set<string>>(new Set());
  const [showSectors, setShowSectors] = useState(true);
  const [showRpsIntro, setShowRpsIntro] = useState(false);

  // 规则扫描状态
  const [perSectorCount, setPerSectorCount] = useState(3);
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState({ current: 0, total: 0 });
  const [scanResults, setScanResults] = useState<ScanResult[]>([]);
  const [scanHistory, setScanHistory] = useState<ScanResult[]>([]);
  const [scanTime, setScanTime] = useState<string>('');
  const abortRef = useRef(false);

  // RPS 扫描状态（localStorage 持久化）
  const [rpsPeriod, setRpsPeriod] = useState(() => parseInt(getStored('period', '250')));
  const [rpsMin, setRpsMin] = useState(() => parseInt(getStored('min', '87')));
  const [rpsIndustry, setRpsIndustry] = useState(() => getStored('industry', ''));
  const [rpsLoading, setRpsLoading] = useState(false);
  const [rpsResults, setRpsResults] = useState<RpsItem[]>([]);

  // 板块 RPS 强度
  const [sectorRps, setSectorRps] = useState<Map<string, number>>(new Map());

  // 加载板块 RPS
  useEffect(() => {
    fetch(`/api/rps/sectors?period=${rpsPeriod}&min=${rpsMin}`)
      .then(r => r.json())
      .then(d => {
        if (d.sectors) {
          const m = new Map<string, number>();
          for (const s of d.sectors) m.set(s.industry, s.ratio);
          setSectorRps(m);
        }
      })
      .catch(() => {});
  }, [rpsPeriod, rpsMin]);

  // 同步选中的板块到 RPS industry
  useEffect(() => {
    if (selectedSectors.size === 1) {
      const sector = SECTORS.find(s => selectedSectors.has(s.id));
      if (sector?.rpsIndustry && sector.rpsIndustry !== rpsIndustry) {
        setRpsIndustry(sector.rpsIndustry);
      }
    }
  }, [selectedSectors]);

  // RPS 配置持久化
  useEffect(() => { setStored('period', String(rpsPeriod)); }, [rpsPeriod]);
  useEffect(() => { setStored('min', String(rpsMin)); }, [rpsMin]);
  useEffect(() => { setStored('industry', rpsIndustry); }, [rpsIndustry]);

  // 点击板块图块
  const toggleSector = (id: string, rpsIndustry?: string) => {
    if (mode === 'rps') {
      // RPS 模式：单选行业筛选
      setRpsIndustry(prev => prev === rpsIndustry ? '' : (rpsIndustry || ''));
      setSelectedSectors(prev => {
        const next = new Set<string>();
        if (!prev.has(id)) next.add(id);
        return next;
      });
    } else {
      // 规则扫描模式：多选板块
      setSelectedSectors(prev => {
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      });
    }
  };

  const selectAllSectors = () => {
    setSelectedSectors(prev => prev.size === SECTORS.length ? new Set() : new Set(SECTORS.map(s => s.id)));
    if (mode === 'rps') setRpsIndustry('');
  };

  // RPS 查询
  const doRpsScan = useCallback(async () => {
    setRpsLoading(true);
    try {
      const params = new URLSearchParams({ period: String(rpsPeriod), minRps: String(rpsMin), limit: '50' });
      if (rpsIndustry) params.set('industry', rpsIndustry);
      const res = await fetch(`/api/scan?${params}`);
      const data = await res.json();
      if (data.items) setRpsResults(data.items);
    } catch {
      toast.error('RPS 查询失败');
    } finally {
      setRpsLoading(false);
    }
  }, [rpsPeriod, rpsMin, rpsIndustry]);

  // RPS 模式：切换板块时自动查询
  const handleRpsSectorClick = (id: string, rpsIndustry?: string) => {
    toggleSector(id, rpsIndustry);
    if (rpsIndustry && rpsIndustry !== rpsIndustry) {
      // 选中了新板块 → 自动查询
      setTimeout(() => setRpsIndustry(rpsIndustry || ''), 0);
    }
  };

  // 规则扫描逻辑
  const buildScanList = (scanMode: 'fresh' | 'continue') => {
    const stocks = new Map<string, { code: string; name: string }>();
    const scanned = new Set(scanHistory.map(r => r.code));
    for (const sector of SECTORS) {
      if (selectedSectors.has(sector.id)) {
        const candidates = scanMode === 'continue' ? sector.stocks.filter(s => !scanned.has(s.code)) : sector.stocks;
        for (const s of candidates.slice(0, perSectorCount)) {
          if (!stocks.has(s.code)) stocks.set(s.code, s);
        }
      }
    }
    return Array.from(stocks.values());
  };

  const doScan = async (scanMode: 'fresh' | 'continue') => {
    if (selectedSectors.size === 0) { toast.error('请先选择板块'); return; }
    const scanList = buildScanList(scanMode);
    if (scanList.length === 0) { toast.error(scanMode === 'continue' ? '没有更多股票可扫描' : '请先选择板块'); return; }
    abortRef.current = false;
    setIsScanning(true);
    setScanProgress({ current: 0, total: scanList.length });
    const results: ScanResult[] = [];
    for (let i = 0; i < scanList.length; i++) {
      if (abortRef.current) break;
      const s = scanList[i];
      setScanProgress({ current: i + 1, total: scanList.length });
      try {
        const quote = await getRealtimeQuote(s.code);
        if (!quote) continue;
        const kLines = await getKLineSina(s.code, 240, 120);
        if (kLines.length < 5) continue;
        const updatedKLines = buildUpdatedKLines(quote, kLines);
        const alertResults = checkAllRules(updatedKLines, quote, SCAN_RULES);
        if (alertResults.length > 0) {
          results.push({ code: s.code, name: quote.name || s.name, quote, alerts: alertResults, alertCount: alertResults.length });
        }
      } catch { /* skip */ }
      await new Promise(r => setTimeout(r, 150));
    }
    results.sort((a, b) => b.alertCount - a.alertCount);
    if (scanMode === 'continue' && scanHistory.length > 0) {
      const existing = new Set(scanHistory.map(r => r.code));
      setScanHistory(prev => [...results.map(r => ({ ...r, isNew: !existing.has(r.code) })), ...prev]);
      setScanResults(prev => [...results.map(r => ({ ...r, isNew: !existing.has(r.code) })), ...prev]);
    } else {
      setScanHistory(results);
      setScanResults(results);
    }
    setScanTime(new Date().toLocaleTimeString('zh-CN'));
    setIsScanning(false);
  };

  const quickScanHot = () => {
    setSelectedSectors(new Set(SECTORS.slice(0, 6).map(s => s.id)));
    setPerSectorCount(3);
    setTimeout(() => doScan('fresh'), 100);
  };

  const openAiAnalysis = (code: string, name: string) => {
    const pure = code.replace(/^(sh|sz|bj)/i, '').replace(/\.(SH|SZ|BJ)$/, '');
    window.open(`/ai?code=${pure}&name=${encodeURIComponent(name)}`, '_blank');
  };

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

  return (
    <div>
      <h1 className="text-xl font-bold text-gray-900 dark:text-white mb-4">市场扫描</h1>

      {/* 模式切换 */}
      <div className="flex gap-2 mb-4">
        <button onClick={() => { setMode('rps'); setSelectedSectors(new Set()); setRpsIndustry(''); }}
          className={cn("px-4 py-2 rounded-lg text-sm font-medium transition",
            mode === 'rps' ? "bg-blue-600 text-white" : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400")}>
          <BarChart3 className="w-4 h-4 inline mr-1" />RPS 排名
        </button>
        <button onClick={() => setMode('rules')}
          className={cn("px-4 py-2 rounded-lg text-sm font-medium transition",
            mode === 'rules' ? "bg-blue-600 text-white" : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400")}>
          <Filter className="w-4 h-4 inline mr-1" />规则扫描
        </button>
      </div>

      {/* 共享板块选择器 */}
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm mb-4">
        <button onClick={() => setShowSectors(!showSectors)} className="w-full p-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Filter className="w-5 h-5 text-blue-600" />
            <span className="font-medium">
              {mode === 'rps' ? '选择行业' : '选择板块'}（{selectedSectors.size > 0 ? `${selectedSectors.size}/${SECTORS.length}` : '未选'}）
            </span>
            {mode === 'rps' && rpsIndustry && <span className="text-sm text-blue-600">当前：{rpsIndustry}</span>}
          </div>
          {showSectors ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
        </button>
        {showSectors && (
          <div className="px-4 pb-4">
            <button onClick={selectAllSectors} className="text-sm text-blue-600 mb-3">
              {selectedSectors.size === SECTORS.length ? '取消全选' : '全选'}
            </button>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
              {SECTORS.map(s => {
                const rpsScore = s.rpsIndustry ? (sectorRps.get(s.rpsIndustry) ?? null) : null;
                return (
                <button key={s.id} onClick={() => toggleSector(s.id, s.rpsIndustry)}
                  className={cn("px-3 py-2.5 rounded-lg text-sm text-left transition border-2 relative",
                    selectedSectors.has(s.id) ? "border-blue-500 bg-blue-50 dark:bg-blue-950" : "border-gray-200 dark:border-gray-700 hover:border-gray-300")}>
                  <span className="mr-1.5">{s.icon}</span>{s.name}
                  <span className="text-xs text-gray-400 ml-1">({s.stocks.length})</span>
                  {rpsScore !== null && (
                    <span className={cn("absolute top-1.5 right-2 text-xs font-mono font-bold",
                      rpsScore >= 50 ? "text-red-600" : rpsScore >= 25 ? "text-orange-500" : "text-gray-400")}>
                      {rpsScore}
                    </span>
                  )}
                </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* ===== RPS 模式 ===== */}
      {mode === 'rps' && (
        <div>
          {/* RPS 说明 */}
          <div className="bg-blue-50 dark:bg-blue-950/30 rounded-xl p-3 mb-4 text-sm">
            <button onClick={() => setShowRpsIntro(!showRpsIntro)} className="flex items-center gap-1 text-blue-600 font-medium w-full text-left">
              <Info className="w-4 h-4" /> RPS 是什么？
              <span className="text-xs text-blue-400 ml-auto">{showRpsIntro ? '收起' : '展开'}</span>
            </button>
            {showRpsIntro && (
              <div className="mt-2 text-gray-600 dark:text-gray-400 space-y-1 leading-relaxed">
                <p><strong>RPS（Relative Price Strength）</strong> 是欧奈尔体系的核心指标，衡量一只股票相对于全市场其他股票的涨幅强度。</p>
                <p>• 计算方式：取该股近 N 日涨幅，在全市场排名，转换为百分位分数（0-100）</p>
                <p>• <strong className="text-red-600">RPS ≥ 87</strong> 意味着这只股票跑赢了全市场 87% 的股票，属于强势股</p>
                <p>• <strong className="text-red-600">RPS ≥ 95</strong> 是极度强势，往往出现在主升浪中</p>
                <p>• 250日 RPS 看长期趋势，20日 RPS 看短期爆发力</p>
                <p className="text-xs text-gray-400 mt-1">注：RPS 高不代表"马上涨"，但历史强势股在启动前往往 RPS 已经很高。结合心姐的选股三原则和仓位管理使用效果更好。</p>
              </div>
            )}
          </div>

          {/* RPS 控制栏 */}
          <Card className="p-4 mb-4">
            <div className="flex flex-wrap items-center gap-3">
              <label className="text-sm text-gray-600 dark:text-gray-400">周期</label>
              <div className="flex gap-1">
                {RPS_PERIODS.map(p => (
                  <button key={p.value} onClick={() => setRpsPeriod(p.value)}
                    className={cn("px-3 py-1.5 rounded-lg text-sm transition",
                      rpsPeriod === p.value ? "bg-blue-600 text-white" : "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200")}>
                    {p.label}
                  </button>
                ))}
              </div>

              <span className="text-gray-300 dark:text-gray-600">|</span>

              <label className="text-sm text-gray-600 dark:text-gray-400">RPS ≥</label>
              <select value={rpsMin} onChange={e => setRpsMin(Number(e.target.value))}
                className="px-3 py-1.5 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm">
                {[70, 75, 80, 85, 87, 90, 92, 95, 97, 99].map(n => <option key={n} value={n}>{n}</option>)}
              </select>

              <button onClick={doRpsScan} disabled={rpsLoading}
                className="px-4 py-1.5 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1">
                {rpsLoading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                查询
              </button>
            </div>
          </Card>

          {/* RPS 结果表 */}
          {rpsResults.length > 0 && (
            <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm overflow-hidden">
              <div className="p-3 border-b border-gray-100 dark:border-gray-800 text-sm text-gray-500">
                共 {rpsResults.length} 只 RPS({rpsPeriod}) ≥ {rpsMin}{rpsIndustry ? ` · ${rpsIndustry}` : ''}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 dark:border-gray-800 text-left text-xs text-gray-400 uppercase">
                      <th className="px-4 py-2 w-12">#</th>
                      <th className="px-4 py-2">股票</th>
                      <th className="px-4 py-2">行业</th>
                      <th className="px-4 py-2 text-right">RPS</th>
                      <th className="px-4 py-2 text-right">涨幅</th>
                      <th className="px-4 py-2 text-right">最新价</th>
                      <th className="px-4 py-2 text-right">日涨跌</th>
                      <th className="px-4 py-2 text-center">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rpsResults.map((item, i) => (
                      <tr key={item.tsCode}
                        onClick={() => router.push(`/stock/${toAppCode(item.tsCode)}`)}
                        className={cn("border-b border-gray-50 dark:border-gray-800/50 hover:bg-gray-50 dark:hover:bg-gray-800/30 transition cursor-pointer",
                          item.rps >= 95 ? "bg-amber-50/30 dark:bg-amber-950/10" : "")}>
                        <td className="px-4 py-2.5 text-gray-400">{i + 1}</td>
                        <td className="px-4 py-2.5">
                          <span className="font-medium">{item.name}</span>
                          <span className="text-gray-400 ml-1.5 text-xs">{item.tsCode.replace(/\.(SH|SZ|BJ)$/, '')}</span>
                        </td>
                        <td className="px-4 py-2.5 text-gray-500">{item.industry}</td>
                        <td className="px-4 py-2.5 text-right">
                          <span className={cn("font-mono font-semibold px-1.5 py-0.5 rounded text-xs",
                            item.rps >= 95 ? "bg-red-100 text-red-700" :
                            item.rps >= 87 ? "bg-orange-100 text-orange-700" :
                            "bg-blue-100 text-blue-700")}>
                            {item.rps.toFixed(1)}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono text-red-600">+{item.ret.toFixed(1)}%</td>
                        <td className="px-4 py-2.5 text-right font-mono">{item.latestClose?.toFixed(2)}</td>
                        <td className={cn("px-4 py-2.5 text-right font-mono", item.latestChange >= 0 ? "text-red-600" : "text-green-600")}>
                          {item.latestChange >= 0 ? '+' : ''}{item.latestChange?.toFixed(2)}%
                        </td>
                        <td className="px-4 py-2.5 text-center" onClick={e => e.stopPropagation()}>
                          <div className="flex items-center justify-center gap-1">
                            {!isInWatchlist(item.tsCode.replace(/\.(SH|SZ|BJ)$/, '')) && (
                              <button onClick={() => addWatch(item.tsCode, item.name)}
                                className="px-2 py-1 text-xs bg-gray-100 text-gray-500 rounded hover:bg-gray-200 transition">
                                <Plus className="w-3 h-3" /> 加自选
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {!rpsLoading && rpsResults.length === 0 && (
            <div className="text-center py-16 text-gray-400">
              <BarChart3 className="w-16 h-16 mx-auto mb-4 opacity-20" />
              <p className="text-lg">选择行业和条件，点击查询</p>
            </div>
          )}
        </div>
      )}

      {/* ===== 规则扫描模式 ===== */}
      {mode === 'rules' && (
        <div>
          <Card className="p-4 mb-4">
            <div className="flex items-center gap-3">
              <label className="text-sm text-gray-600 dark:text-gray-400">每板块取前</label>
              <select value={perSectorCount} onChange={e => setPerSectorCount(Number(e.target.value))}
                className="px-3 py-1.5 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm">
                {[1, 2, 3, 5, 8, 10, 20, 50, 80].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
              <span className="text-sm text-gray-500">只</span>
            </div>
          </Card>

          <div className="flex gap-3 mb-4">
            <button onClick={quickScanHot} disabled={isScanning}
              className="flex-1 py-3 bg-gradient-to-r from-orange-500 to-red-500 text-white rounded-xl font-medium flex items-center justify-center gap-2 hover:opacity-90 transition disabled:opacity-50">
              <Zap className="w-5 h-5" /> 一键扫描热门
            </button>
            <button onClick={() => doScan('fresh')} disabled={isScanning}
              className="flex-1 py-3 bg-blue-600 text-white rounded-xl font-medium flex items-center justify-center gap-2 hover:bg-blue-700 transition disabled:opacity-50">
              <Search className="w-5 h-5" /> 开始扫描
            </button>
            {scanHistory.length > 0 && (
              <button onClick={() => doScan('continue')} disabled={isScanning}
                className="flex-1 py-3 bg-green-600 text-white rounded-xl font-medium flex items-center justify-center gap-2 hover:bg-green-700 transition disabled:opacity-50">
                <TrendingUp className="w-5 h-5" /> 继续扫描
              </button>
            )}
            {isScanning && (
              <button onClick={() => { abortRef.current = true; setIsScanning(false); }}
                className="px-4 py-3 bg-red-500 text-white rounded-xl font-medium hover:bg-red-600 transition">停止</button>
            )}
          </div>

          {isScanning && (
            <div className="bg-white dark:bg-gray-900 rounded-xl p-4 shadow-sm mb-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm">扫描中... {scanProgress.current}/{scanProgress.total}</span>
                <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
              </div>
              <div className="h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${(scanProgress.current / scanProgress.total) * 100}%` }} />
              </div>
            </div>
          )}

          {scanResults.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-medium">发现 {scanResults.length} 只有信号的股票
                    {scanResults.some(r => r.isNew) && <span className="ml-2 text-xs bg-green-100 text-green-600 px-2 py-0.5 rounded-full">+{scanResults.filter(r => r.isNew).length} NEW</span>}
                  </h3>
                  {scanTime && <p className="text-xs text-gray-400 mt-0.5">{scanTime} 完成</p>}
                </div>
                <button onClick={() => { setScanResults([]); setScanHistory([]); setScanTime(''); }}
                  className="px-3 py-1.5 text-xs text-gray-500 hover:text-red-500 hover:bg-red-50 rounded-lg transition">全部清除</button>
              </div>
              {scanResults.map(r => (
                <div key={r.code} className="bg-white dark:bg-gray-900 rounded-xl p-4 shadow-sm">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      {r.isNew && <span className="text-xs bg-green-500 text-white px-1.5 py-0.5 rounded font-bold">NEW</span>}
                      <button onClick={() => openAiAnalysis(r.code, r.name)} className="font-semibold hover:text-blue-600 transition flex items-center gap-1">
                        {r.name}<ExternalLink className="w-3 h-3 text-gray-400" />
                      </button>
                      <p className="text-sm text-gray-500">{r.code}</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={cn("text-sm font-medium px-2 py-0.5 rounded-full",
                        r.alertCount >= 3 ? "bg-red-100 text-red-600" : r.alertCount >= 2 ? "bg-orange-100 text-orange-600" : "bg-blue-100 text-blue-600")}>{r.alertCount}个信号</span>
                      {!isInWatchlist(r.code) && (
                        <button onClick={() => addWatch(r.code, r.name)}
                          className="px-3 py-1.5 bg-blue-100 text-blue-600 text-sm rounded-lg hover:bg-blue-200 transition flex items-center gap-1"><Plus className="w-3.5 h-3.5" />加自选</button>
                      )}
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    {r.alerts.map((a: any, i: number) => {
                      const rule = ALERT_RULES.find(ru => ru.id === a.ruleId);
                      const isOpp = rule?.category === 'OPPORTUNITY' || rule?.level === 'INFO';
                      return <div key={i} className={cn("text-sm p-2 rounded-lg",
                        isOpp ? "bg-green-50 dark:bg-green-950 text-green-700" :
                        rule?.level === 'CRITICAL' ? "bg-red-50 dark:bg-red-950 text-red-700" : "bg-orange-50 dark:bg-orange-950 text-orange-700")}>
                        <span className="font-medium">{rule?.name || a.ruleId}</span><span className="mx-1.5">—</span>{a.message}</div>;
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
