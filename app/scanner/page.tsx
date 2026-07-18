'use client';

import React, { useState, useRef } from 'react';
import { useStockStore } from '@/store';
import { getRealtimeQuote, getKLineSina } from '@/services/stockApi';
import { ALERT_RULES, checkAllRules } from '@/services/alertRules';
import { SECTORS } from '@/lib/sectors';
import { cn } from '@/lib/utils';
import { buildUpdatedKLines } from '@/lib/stock-helpers';
import { Card } from '@/components/ui/card';
import { Search, TrendingUp, Filter, Loader2, Zap, ChevronDown, ChevronUp, Plus } from 'lucide-react';
import { toast } from 'sonner';

interface ScanResult {
  code: string;
  name: string;
  quote: any;
  alerts: any[];
  alertCount: number;
  isNew?: boolean;
}

const SCAN_RULES = ALERT_RULES.filter(r =>
  ['R001', 'R003', 'R006', 'R011', 'R012', 'R013', 'R014', 'R015', 'R016', 'R017'].includes(r.id)
);

export default function ScannerPage() {
  const { addToWatchlist, isInWatchlist } = useStockStore();
  const [selectedSectors, setSelectedSectors] = useState<Set<string>>(new Set());
  const [perSectorCount, setPerSectorCount] = useState(3);
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState({ current: 0, total: 0 });
  const [scanResults, setScanResults] = useState<ScanResult[]>([]);
  const [scanHistory, setScanHistory] = useState<ScanResult[]>([]);
  const [scanTime, setScanTime] = useState<string>('');
  const [showSectors, setShowSectors] = useState(true);
  const abortRef = useRef(false);

  const toggleSector = (code: string) => setSelectedSectors(prev => {
    const next = new Set(prev);
    next.has(code) ? next.delete(code) : next.add(code);
    return next;
  });

  const selectAllSectors = () => {
    setSelectedSectors(prev => prev.size === SECTORS.length ? new Set() : new Set(SECTORS.map(s => s.id)));
  };

  // 构建扫描清单
  const buildScanList = (mode: 'fresh' | 'continue') => {
    const stocks = new Map<string, { code: string; name: string }>();
    const scanned = new Set(scanHistory.map(r => r.code));

    for (const sector of SECTORS) {
      if (selectedSectors.has(sector.id)) {
        const candidates = mode === 'continue'
          ? sector.stocks.filter(s => !scanned.has(s.code))
          : sector.stocks;
        for (const s of candidates.slice(0, perSectorCount)) {
          if (!stocks.has(s.code)) stocks.set(s.code, s);
        }
      }
    }
    return Array.from(stocks.values());
  };

  const doScan = async (mode: 'fresh' | 'continue') => {
    if (selectedSectors.size === 0) { toast.error('请先选择板块'); return; }

    const scanList = buildScanList(mode);
    if (scanList.length === 0) {
      toast.error(mode === 'continue' ? '没有更多股票可扫描' : '请先选择板块');
      return;
    }

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

    if (mode === 'continue' && scanHistory.length > 0) {
      const existing = new Set(scanHistory.map(r => r.code));
      const tagged = results.map(r => ({ ...r, isNew: !existing.has(r.code) }));
      setScanHistory(prev => [...tagged, ...prev]);
      setScanResults(prev => [...tagged, ...prev]);
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

  return (
    <div>
      <h1 className="text-xl font-bold text-gray-900 dark:text-white mb-4">市场扫描</h1>

      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm mb-4">
        <button onClick={() => setShowSectors(!showSectors)} className="w-full p-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Filter className="w-5 h-5 text-blue-600" />
            <span className="font-medium">选择板块（已选 {selectedSectors.size}/{SECTORS.length}）</span>
          </div>
          {showSectors ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
        </button>
        {showSectors && (
          <div className="px-4 pb-4">
            <button onClick={selectAllSectors} className="text-sm text-blue-600 mb-3">
              {selectedSectors.size === SECTORS.length ? '取消全选' : '全选'}
            </button>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
              {SECTORS.map(s => (
                <button key={s.id} onClick={() => toggleSector(s.id)}
                  className={cn("px-3 py-2.5 rounded-lg text-sm text-left transition border-2",
                    selectedSectors.has(s.id) ? "border-blue-500 bg-blue-50 dark:bg-blue-950" : "border-gray-200 dark:border-gray-700 hover:border-gray-300")}>
                  <span className="mr-1.5">{s.icon}</span>{s.name}<span className="text-xs text-gray-400 ml-1">({s.stocks.length})</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <Card className="mb-4">
        <div className="flex items-center gap-3">
          <label className="text-sm text-gray-600 dark:text-gray-400 whitespace-nowrap">每板块取前</label>
          <select value={perSectorCount} onChange={e => setPerSectorCount(Number(e.target.value))}
            className="px-3 py-1.5 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm">
            {[1, 2, 3, 5, 8, 10, 20, 50, 80].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
          <span className="text-sm text-gray-500">只（每板块共{SECTORS[0]?.stocks.length || 0}只）</span>
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
              {scanTime && <p className="text-xs text-gray-400 mt-0.5">🕐 {scanTime} 完成</p>}
            </div>
            <button onClick={() => { setScanResults([]); setScanHistory([]); setScanTime(''); }}
              className="px-3 py-1.5 text-xs text-gray-500 hover:text-red-500 hover:bg-red-50 rounded-lg transition">全部清除</button>
          </div>
          {scanResults.map(r => (
            <div key={r.code} className="bg-white dark:bg-gray-900 rounded-xl p-4 shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  {r.isNew && <span className="text-xs bg-green-500 text-white px-1.5 py-0.5 rounded font-bold">NEW</span>}
                  <h3 className="font-semibold">{r.name}</h3>
                  <p className="text-sm text-gray-500">{r.code}</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className={cn("text-sm font-medium px-2 py-0.5 rounded-full",
                    r.alertCount >= 3 ? "bg-red-100 text-red-600" : r.alertCount >= 2 ? "bg-orange-100 text-orange-600" : "bg-blue-100 text-blue-600")}>{r.alertCount}个信号</span>
                  {!isInWatchlist(r.code) && (
                    <button onClick={() => { addToWatchlist({ code: r.code, name: r.name, market: r.code.startsWith('6') ? 'sh' : r.code.startsWith('0') || r.code.startsWith('3') ? 'sz' : 'bj', pureCode: r.code.replace(/^[a-z]+/, '') }); toast.success(`已添加 ${r.name}`); }}
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

      {!isScanning && scanResults.length === 0 && (
        <div className="text-center py-16 text-gray-400">
          <Filter className="w-16 h-16 mx-auto mb-4 opacity-20" />
          <p className="text-lg">选择板块开始扫描</p>
          <p className="text-sm mt-2">12个板块 · 每板块最多80只股票 · 共{new Set(SECTORS.flatMap(s => s.stocks.map(x => x.code))).size}只</p>
        </div>
      )}
    </div>
  );
}
