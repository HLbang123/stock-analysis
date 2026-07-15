'use client';

import React, { useEffect, useState, useMemo } from 'react';
import { useParams } from 'next/navigation';
import { useStockStore } from '@/store';
import { getRealtimeQuote, getKLineSina, getMinuteData } from '@/services/stockApi';
import { ALERT_RULES, checkAllRules } from '@/services/alertRules';
import { RealtimeQuote, KLineData, RuleCheckResult } from '@/types';
import { formatPrice, formatChange, formatVolume, cn, getAlertLevelColor } from '@/lib/utils';
import { ArrowLeft, RefreshCw, TrendingUp } from 'lucide-react';
import Link from 'next/link';
import { KLineChart } from '@/components/KLineChart';
import { MinuteChart } from '@/components/MinuteChart';

export default function StockDetailPage() {
  const params = useParams();
  const code = params.code as string;

  const { watchlist, addToWatchlist, removeFromWatchlist, isInWatchlist, alerts } = useStockStore();

  const [quote, setQuote] = useState<RealtimeQuote | null>(null);
  const [kLines, setKLines] = useState<KLineData[]>([]);
  const [minuteData, setMinuteData] = useState<{ time: string; price: number; volume: number; avgPrice: number }[]>([]);
  const [ruleResults, setRuleResults] = useState<RuleCheckResult[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [chartTab, setChartTab] = useState<'kline' | 'minute'>('minute');
  const [error, setError] = useState<string | null>(null);

  const stock = watchlist.find(s => s.code === code);
  const stockName = quote?.name || stock?.name || code;

  // 该股票的历史预警
  const stockAlerts = useMemo(
    () => alerts.filter(a => a.stockCode === code).slice(-10).reverse(),
    [alerts, code]
  );

  // 加载数据
  const loadData = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [quoteData, kLineData, minData] = await Promise.all([
        getRealtimeQuote(code),
        getKLineSina(code, 240, 120),
        getMinuteData(code),
      ]);

      if (!quoteData) {
        setError('获取行情失败，请检查股票代码');
        return;
      }

      setQuote(quoteData);
      setKLines(kLineData);
      setMinuteData(minData || []);

      // 构建实时K线并检查规则
      if (kLineData.length >= 5) {
        const todayStr = new Date().toISOString().split('T')[0];
        const todayKLine = {
          date: todayStr,
          open: quoteData.open,
          high: quoteData.high,
          low: quoteData.low,
          close: quoteData.price,
          volume: quoteData.volume,
        };

        // K线API有时已包含今天数据，需要先移除再用实时数据替换
        const historicalKLines = kLineData.filter(k => k.date !== todayStr);
        const updatedKLines = [...historicalKLines, todayKLine];
        const results = checkAllRules(updatedKLines, quoteData, ALERT_RULES.filter(r => r.isEnabled));

        // DEBUG: 打印关键数据用于排查预警问题
        const lastK = kLineData[kLineData.length - 1];
        const today = updatedKLines[updatedKLines.length - 1];
        const prev = updatedKLines[updatedKLines.length - 2];
        const changePct = ((today.close - prev.close) / prev.close) * 100;
        const ma5 = updatedKLines.slice(-6, -1).reduce((s, k) => s + k.close, 0) / 5;
        console.log('[DEBUG] 股票:', code);
        console.log('[DEBUG] K线总数:', kLineData.length, '总数据:', updatedKLines.length);
        console.log('[DEBUG] 最近K线日期:', lastK?.date, 'close:', lastK?.close, 'volume:', lastK?.volume);
        console.log('[DEBUG] Quote价格:', quoteData.price, '昨收:', quoteData.preClose, '涨跌%:', quoteData.changePercent);
        console.log('[DEBUG] todayKLine:', JSON.stringify(todayKLine));
        console.log('[DEBUG] 涨跌幅(today vs prev):', changePct.toFixed(2) + '%');
        console.log('[DEBUG] MA5:', ma5.toFixed(2), 'today.close<MA5:', today.close < ma5);
        console.log('[DEBUG] 量比:', (today.volume / (prev.volume || 1)).toFixed(2));
        console.log('[DEBUG] 触发规则数:', results.length);
        results.forEach(r => console.log('[DEBUG] 触发:', r.ruleId, r.message));

        setRuleResults(results);
      }
    } catch (err) {
      console.error('加载股票数据失败:', err);
      setError('加载失败，请稍后重试');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (code) {
      loadData();
    }
  }, [code]);

  // 预警标记到K线索引的映射
  const kLineMarkers = useMemo(() => {
    const markerMap: Record<number, number> = {};
    ruleResults.forEach((result, i) => {
      const idx = result.barIndex ?? kLines.length;
      markerMap[idx] = i + 1;
    });
    return markerMap;
  }, [ruleResults, kLines]);

  // 分时图预警标记（智能定位：见顶放最高点，见底放最低点，量放量最大点）
  const minuteMarkers = useMemo(() => {
    if (minuteData.length === 0 || ruleResults.length === 0) return [];
    return ruleResults.map((result, i) => {
      let index = minuteData.length - 1; // 默认最后一点
      const ruleId = result.ruleId || '';
      if (['R003', 'R014', 'R006', 'R002'].includes(ruleId)) {
        // 见顶形态 → 最高价位置
        let maxIdx = 0; let maxPrice = 0;
        minuteData.forEach((p, idx) => { if (p.price > maxPrice) { maxPrice = p.price; maxIdx = idx; } });
        index = maxIdx;
      } else if (['R010', 'R015', 'R011'].includes(ruleId)) {
        // 见底形态 → 最低价位置
        let minIdx = 0; let minPrice = Infinity;
        minuteData.forEach((p, idx) => { if (p.price < minPrice) { minPrice = p.price; minIdx = idx; } });
        index = minIdx;
      } else if (ruleId === 'R001') {
        // 量能 → 最大量位置
        let maxIdx = 0; let maxVol = 0;
        minuteData.forEach((p, idx) => { if (p.volume > maxVol) { maxVol = p.volume; maxIdx = idx; } });
        index = maxIdx;
      }
      return { index, number: i + 1, level: ALERT_RULES.find(r => r.id === ruleId)?.level || 'INFO' };
    });
  }, [ruleResults, minuteData]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <RefreshCw className="w-8 h-8 animate-spin text-blue-500" />
      </div>
    );
  }

  return (
    <div>
      {/* 顶部导航 */}
      <div className="flex items-center gap-3 mb-4">
        <Link href="/" className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">{stockName}</h1>
          <p className="text-sm text-gray-500">{code}</p>
        </div>
        <button
          onClick={loadData}
          className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition"
          title="刷新"
        >
          <RefreshCw className="w-5 h-5" />
        </button>
        {stock ? (
          <button
            onClick={() => removeFromWatchlist(code)}
            className="px-4 py-2 text-sm bg-red-50 text-red-600 rounded-lg hover:bg-red-100 transition"
          >
            移除自选
          </button>
        ) : (
          <button
            onClick={() => {
              if (quote) {
                const market = code.startsWith('6') ? 'sh' : code.startsWith('0') || code.startsWith('3') ? 'sz' : 'bj';
                addToWatchlist({ code, name: quote.name, market, pureCode: code.replace(/^[a-z]+/, '') });
              }
            }}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
          >
            添加自选
          </button>
        )}
      </div>

      {error ? (
        <div className="bg-red-50 text-red-600 p-6 rounded-xl text-center">
          <p>{error}</p>
          <button onClick={loadData} className="mt-3 text-sm underline">重试</button>
        </div>
      ) : (
        <>
          {/* 实时行情卡片 */}
          {quote && (
            <div className="bg-white dark:bg-gray-900 rounded-xl p-5 shadow-sm mb-4">
              <div className="flex items-end justify-between mb-4">
                <div>
                  <p className={cn(
                    "text-3xl font-bold",
                    quote.changePercent >= 0 ? "text-red-500" : "text-green-500"
                  )}>
                    {formatPrice(quote.price)}
                  </p>
                  <p className={cn(
                    "text-lg mt-1",
                    quote.changePercent >= 0 ? "text-red-500" : "text-green-500"
                  )}>
                    {formatChange(quote.changePercent)}
                  </p>
                </div>
                <div className="text-right text-sm text-gray-500">
                  <p>昨收: {formatPrice(quote.preClose)}</p>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3 text-sm">
                <div>
                  <p className="text-gray-500">开盘</p>
                  <p className={cn("font-medium", quote.open >= quote.preClose ? "text-red-500" : "text-green-500")}>
                    {formatPrice(quote.open)}
                  </p>
                </div>
                <div>
                  <p className="text-gray-500">最高</p>
                  <p className="font-medium text-red-500">{formatPrice(quote.high)}</p>
                </div>
                <div>
                  <p className="text-gray-500">最低</p>
                  <p className="font-medium text-green-500">{formatPrice(quote.low)}</p>
                </div>
                <div>
                  <p className="text-gray-500">成交量</p>
                  <p className="font-medium">{formatVolume(quote.volume)}</p>
                </div>
                <div>
                  <p className="text-gray-500">成交额</p>
                  <p className="font-medium">{quote.amount ? formatVolume(quote.amount) : '--'}</p>
                </div>
                <div>
                  <p className="text-gray-500">涨跌额</p>
                  <p className={cn("font-medium", quote.change >= 0 ? "text-red-500" : "text-green-500")}>
                    {quote.change > 0 ? '+' : ''}{quote.change?.toFixed(2)}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* 图表切换 */}
          <div className="flex gap-2 mb-4">
            <button
              onClick={() => setChartTab('minute')}
              className={cn(
                "px-4 py-2 rounded-lg text-sm font-medium transition",
                chartTab === 'minute'
                  ? "bg-blue-600 text-white"
                  : "bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 hover:bg-gray-100"
              )}
            >
              分时图
            </button>
            <button
              onClick={() => setChartTab('kline')}
              className={cn(
                "px-4 py-2 rounded-lg text-sm font-medium transition",
                chartTab === 'kline'
                  ? "bg-blue-600 text-white"
                  : "bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 hover:bg-gray-100"
              )}
            >
              日K线
            </button>
          </div>

          {/* 分时图 */}
          {chartTab === 'minute' && (
            <div className="bg-white dark:bg-gray-900 rounded-xl p-4 shadow-sm mb-4">
              {minuteData.length > 0 ? (
                <MinuteChart
                  data={minuteData}
                  prevClose={quote?.preClose || 0}
                  height={400}
                  alertMarkers={minuteMarkers}
                />
              ) : (
                <div className="flex items-center justify-center h-[400px] text-gray-400">
                  <div className="text-center">
                    <TrendingUp className="w-12 h-12 mx-auto mb-3 opacity-30" />
                    <p>暂无分时数据</p>
                    <p className="text-sm mt-1">非交易时段不提供实时分时数据</p>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* K线图 */}
          {chartTab === 'kline' && (
            <div className="bg-white dark:bg-gray-900 rounded-xl p-4 shadow-sm mb-4">
              <KLineChart
                data={kLines}
                height={400}
                alertMarkers={Object.entries(kLineMarkers).map(([barIndex, number]) => ({
                  barIndex: parseInt(barIndex),
                  number,
                  level: ruleResults[number - 1]?.ruleId
                    ? (ALERT_RULES.find(r => r.id === ruleResults[number - 1].ruleId)?.level || 'INFO')
                    : 'INFO',
                }))}
              />
            </div>
          )}

          {/* 触发规则列表 */}
          {ruleResults.length > 0 && (
            <div className="bg-white dark:bg-gray-900 rounded-xl p-4 shadow-sm mb-4">
              <h2 className="font-semibold text-gray-900 dark:text-white mb-3">
                触发规则 ({ruleResults.length})
              </h2>
              <div className="space-y-2">
                {ruleResults.map((result, i) => {
                  const rule = ALERT_RULES.find(r => r.id === result.ruleId);
                  return (
                    <div
                      key={i}
                      className={cn(
                        "p-3 rounded-lg border-l-4",
                        getAlertLevelColor(rule?.level || 'INFO')
                      )}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-medium">
                          {rule?.level === 'CRITICAL' ? '🔴' : rule?.level === 'WARNING' ? '🟡' : '🔵'}
                        </span>
                        <span className="font-medium">{rule?.name || result.ruleId}</span>
                        {rule && (
                          <span className={cn(
                            "text-xs px-1.5 py-0.5 rounded",
                            rule.level === 'CRITICAL' ? "bg-red-100 text-red-700" :
                            rule.level === 'WARNING' ? "bg-orange-100 text-orange-700" :
                            "bg-blue-100 text-blue-700"
                          )}>
                            {rule.level}
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-gray-600 dark:text-gray-400 ml-7">
                        {result.message}
                      </p>
                      {rule?.suggestion && (
                        <p className="text-xs text-gray-500 mt-1 ml-7">
                          建议: {rule.suggestion}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 历史预警 */}
          {stockAlerts.length > 0 && (
            <div className="bg-white dark:bg-gray-900 rounded-xl p-4 shadow-sm">
              <h2 className="font-semibold text-gray-900 dark:text-white mb-3">
                历史预警 ({stockAlerts.length})
              </h2>
              <div className="space-y-2">
                {stockAlerts.map(alert => (
                  <div
                    key={alert.id}
                    className="p-3 bg-gray-50 dark:bg-gray-800 rounded-lg"
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs text-gray-500">
                        {new Date(alert.triggeredAt).toLocaleString('zh-CN')}
                      </span>
                      <span className="text-sm font-medium">{alert.ruleName}</span>
                    </div>
                    <p className="text-sm text-gray-600 dark:text-gray-400">
                      {alert.alertMessage}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 无触发规则 */}
          {ruleResults.length === 0 && (
            <div className="bg-white dark:bg-gray-900 rounded-xl p-8 shadow-sm text-center text-gray-400">
              <p>未触发任何预警规则</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
