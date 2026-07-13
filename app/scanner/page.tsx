'use client';

import React, { useState } from 'react';
import { getKLineSina, getRealtimeQuote, parseStockCode } from '@/services/stockApi';
import { ALERT_RULES, checkAllRules } from '@/services/alertRules';
import { Stock, RealtimeQuote } from '@/types';
import { formatPrice, formatChange, formatVolume, cn } from '@/lib/utils';
import { Search, TrendingUp, Filter, Loader2 } from 'lucide-react';
import { useStockStore } from '@/store';

export default function ScannerPage() {
  const { addToWatchlist, isInWatchlist } = useStockStore();
  const [stockInput, setStockInput] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const [scanResults, setScanResults] = useState<any[]>([]);

  // 常用股票池（示例）
  const commonStocks = [
    { code: 'sh600519', name: '贵州茅台' },
    { code: 'sh601138', name: '工业富联' },
    { code: 'sz300059', name: '东方财富' },
    { code: 'sz000001', name: '平安银行' },
    { code: 'sz000858', name: '五粮液' },
    { code: 'sh601318', name: '中国平安' },
    { code: 'sz300750', name: '宁德时代' },
    { code: 'sh688981', name: '中芯国际' },
  ];

  // 快速扫描单只股票
  const scanStock = async (stockCode: string) => {
    setIsScanning(true);
    try {
      // 获取实时行情
      const quote = await getRealtimeQuote(stockCode);
      if (!quote) {
        setScanResults([{ code: stockCode, error: '获取行情失败' }]);
        return;
      }

      // 获取K线
      const kLines = await getKLineSina(stockCode, 240, 120);
      if (kLines.length < 10) {
        setScanResults([{ code: stockCode, error: 'K线数据不足' }]);
        return;
      }

      // 组合实时数据
      const todayKLine = {
        date: new Date().toISOString().split('T')[0],
        open: quote.open,
        high: quote.high,
        low: quote.low,
        close: quote.price,
        volume: quote.volume
      };
      const updatedKLines = [...kLines, todayKLine];

      // 检查规则
      const results = checkAllRules(updatedKLines, quote, ALERT_RULES.filter(r => r.isEnabled));

      setScanResults([{
        code: stockCode,
        name: quote.name,
        quote,
        kLines: updatedKLines,
        alerts: results,
        alertCount: results.length
      }]);
    } catch (error) {
      console.error('扫描失败:', error);
      setScanResults([{ code: stockCode, error: '扫描失败' }]);
    } finally {
      setIsScanning(false);
    }
  };

  // 批量扫描
  const scanMultiple = async (stocks: { code: string; name: string }[]) => {
    setIsScanning(true);
    setScanResults([]);

    const results = [];

    for (const stock of stocks) {
      try {
        const quote = await getRealtimeQuote(stock.code);
        if (!quote) continue;

        const kLines = await getKLineSina(stock.code, 240, 120);
        if (kLines.length < 10) continue;

        const todayKLine = {
          date: new Date().toISOString().split('T')[0],
          open: quote.open,
          high: quote.high,
          low: quote.low,
          close: quote.price,
          volume: quote.volume
        };

        const alertResults = checkAllRules(
          [...kLines, todayKLine],
          quote,
          ALERT_RULES.filter(r => r.isEnabled)
        );

        if (alertResults.length > 0) {
          results.push({
            code: stock.code,
            name: quote.name,
            quote,
            alerts: alertResults,
            alertCount: alertResults.length
          });
        }
      } catch (error) {
        console.error(`扫描 ${stock.code} 失败:`, error);
      }

      // 避免请求过快
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    setScanResults(results);
    setIsScanning(false);
  };

  // 添加到自选
  const handleAddStock = (code: string, name: string) => {
    const { market, pureCode } = parseStockCode(code);
    addToWatchlist({ code, name, market, pureCode });
  };

  // 处理输入扫描
  const handleScanInput = () => {
    if (!stockInput.trim()) return;
    const parsed = parseStockCode(stockInput);
    scanStock(parsed.fullCode);
  };

  return (
    <div className="min-h-screen bg-gray-50 pb-20">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 py-4">
          <h1 className="text-xl font-bold text-gray-900">股票筛选</h1>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-6">
        {/* 快速扫描按钮 */}
        <div className="bg-white rounded-xl p-4 shadow-sm mb-6">
          <div className="flex items-center gap-2 mb-3">
            <Filter className="w-5 h-5 text-blue-600" />
            <h2 className="font-medium">快速扫描</h2>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <button
              onClick={() => scanMultiple(commonStocks)}
              disabled={isScanning}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition text-sm disabled:opacity-50"
            >
              扫描热门股
            </button>
            <button
              onClick={() => scanMultiple(commonStocks.slice(0, 4))}
              disabled={isScanning}
              className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition text-sm disabled:opacity-50"
            >
              扫描前4只
            </button>
          </div>
        </div>

        {/* 自定义扫描 */}
        <div className="bg-white rounded-xl p-4 shadow-sm mb-6">
          <div className="flex items-center gap-2 mb-3">
            <Search className="w-5 h-5 text-blue-600" />
            <h2 className="font-medium">自定义扫描</h2>
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={stockInput}
              onChange={(e) => setStockInput(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && handleScanInput()}
              placeholder="输入股票代码 (如: 600519)"
              className="flex-1 px-4 py-3 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              onClick={handleScanInput}
              disabled={isScanning || !stockInput.trim()}
              className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition disabled:opacity-50"
            >
              {isScanning ? <Loader2 className="w-5 h-5 animate-spin" /> : '扫描'}
            </button>
          </div>
        </div>

        {/* 扫描结果 */}
        {isScanning && (
          <div className="text-center py-12 text-gray-400">
            <Loader2 className="w-8 h-8 mx-auto mb-3 animate-spin" />
            <p>正在扫描...</p>
          </div>
        )}

        {scanResults.length === 0 && !isScanning && (
          <div className="text-center py-20 text-gray-400">
            <Filter className="w-16 h-16 mx-auto mb-4 opacity-20" />
            <p className="text-lg">暂无扫描结果</p>
            <p className="text-sm mt-2">点击上方按钮开始扫描</p>
          </div>
        )}

        {scanResults.length > 0 && (
          <div className="space-y-4">
            <h3 className="font-medium text-gray-700">
              扫描结果 ({scanResults.length} 只股票有预警)
            </h3>
            {scanResults.map((result, idx) => (
              <div key={result.code} className="bg-white rounded-xl p-4 shadow-sm">
                {result.error ? (
                  <div className="text-red-500 text-sm">{result.error}</div>
                ) : (
                  <>
                    <div className="flex items-center justify-between mb-3">
                      <div>
                        <h3 className="font-semibold">{result.name}</h3>
                        <p className="text-sm text-gray-500">{result.code}</p>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="text-right">
                          <p className={cn("font-semibold text-lg", result.quote.changePercent >= 0 ? "text-red-500" : "text-green-500")}>
                            {formatPrice(result.quote.price)}
                          </p>
                          <p className={cn("text-sm", result.quote.changePercent >= 0 ? "text-red-500" : "text-green-500")}>
                            {formatChange(result.quote.changePercent)}
                          </p>
                        </div>
                        {!isInWatchlist(result.code) && (
                          <button
                            onClick={() => handleAddStock(result.code, result.name)}
                            className="px-3 py-1.5 bg-blue-100 text-blue-600 text-sm rounded-lg hover:bg-blue-200 transition"
                          >
                            添加自选
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="border-t border-gray-100 pt-3">
                      <p className="text-sm text-gray-500 mb-2">
                        发现 {result.alertCount} 条预警:
                      </p>
                      <div className="space-y-1">
                        {result.alerts.map((alert: any, i: number) => (
                          <div key={i} className="text-sm p-2 bg-gray-50 rounded">
                            {alert.message}
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </main>

      {/* 底部导航 */}
      <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200">
        <div className="max-w-4xl mx-auto flex">
          <a
            href="/"
            className="flex-1 py-3 flex flex-col items-center gap-1 text-gray-400 hover:text-gray-600 transition"
          >
            <TrendingUp className="w-6 h-6" />
            <span className="text-xs">预警</span>
          </a>
          <a
            href="/watchlist"
            className="flex-1 py-3 flex flex-col items-center gap-1 text-gray-400 hover:text-gray-600 transition"
          >
            <Search className="w-6 h-6" />
            <span className="text-xs">自选</span>
          </a>
          <a
            href="/scanner"
            className="flex-1 py-3 flex flex-col items-center gap-1 text-blue-600"
          >
            <Filter className="w-6 h-6" />
            <span className="text-xs">筛选</span>
          </a>
        </div>
      </nav>
    </div>
  );
}