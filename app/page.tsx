'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useStockStore } from '@/store';
import { getRealtimeQuote, getKLineSina } from '@/services/stockApi';
import { ALERT_RULES, checkAllRules } from '@/services/alertRules';
import { AlertRecord } from '@/types';
import { formatTime, cn, getAlertLevelColor } from '@/lib/utils';
import { AlertTriangle, RefreshCw, Trash2, Plus } from 'lucide-react';

export default function HomePage() {
  const { watchlist, alerts, isCheckingAlerts, addAlerts, markAsRead, clearAlerts, clearAllAlerts, setIsCheckingAlerts, rules } = useStockStore();

  const [resultMessage, setResultMessage] = useState<string | null>(null);

  // 初始化规则
  useEffect(() => {
    const store = useStockStore.getState();
    if (store.rules.length === 0) {
      useStockStore.setState({ rules: ALERT_RULES });
    }
  }, []);

  // 分组预警
  const groupedAlerts = useMemo(() => {
    const groups = new Map<string, AlertRecord[]>();
    alerts.forEach(alert => {
      const key = alert.stockCode;
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(alert);
    });

    return Array.from(groups.entries()).map(([stockCode, stockAlerts]) => {
      const worstLevel = stockAlerts.some(a => a.alertLevel === 'CRITICAL')
        ? 'CRITICAL'
        : stockAlerts.some(a => a.alertLevel === 'WARNING')
          ? 'WARNING'
          : 'INFO';
      return {
        stockCode,
        stockName: stockAlerts[0].stockName,
        alerts: stockAlerts,
        worstLevel,
        latestTime: Math.max(...stockAlerts.map(a => a.triggeredAt))
      };
    }).sort((a, b) => b.latestTime - a.latestTime);
  }, [alerts]);

  // 未读数
  const unreadCount = alerts.filter(a => !a.isRead).length;

  // 检查预警
  const checkAlerts = async () => {
    if (watchlist.length === 0) {
      setResultMessage('请先添加自选股');
      setTimeout(() => setResultMessage(null), 3000);
      return;
    }

    setIsCheckingAlerts(true);
    setResultMessage(null);

    try {
      const allNewAlerts: AlertRecord[] = [];

      for (const stock of watchlist) {
        // 获取实时行情
        const quote = await getRealtimeQuote(stock.code);
        if (!quote) continue;

        // 获取K线数据
        const kLines = await getKLineSina(stock.code, 240, 120);

        if (kLines.length < 10) continue;

        // 获取最新一天的实时数据
        const latestQuote = quote;
        const todayKLine = {
          date: new Date().toISOString().split('T')[0],
          open: latestQuote.open,
          high: latestQuote.high,
          low: latestQuote.low,
          close: latestQuote.price,
          volume: latestQuote.volume
        };

        const updatedKLines = [...kLines, todayKLine];

        // 检查规则
        const enabledRules = rules.filter(r => r.isEnabled);
        const results = checkAllRules(updatedKLines, latestQuote, enabledRules);

        for (const result of results) {
          const rule = enabledRules.find(r => r.id === result.ruleId);
          if (rule) {
            allNewAlerts.push({
              id: `${Date.now()}-${stock.code}-${result.ruleId}`,
              stockCode: stock.code,
              stockName: stock.name || quote.name,
              ruleId: result.ruleId!,
              ruleName: rule.name,
              alertLevel: rule.level,
              alertMessage: result.message!,
              suggestion: rule.suggestion,
              triggeredAt: Date.now(),
              isRead: false,
              extraData: result.extraData
            });
          }
        }
      }

      if (allNewAlerts.length > 0) {
        addAlerts(allNewAlerts);
        setResultMessage(`检测完成，发现 ${allNewAlerts.length} 条新预警`);
      } else {
        setResultMessage('检测完成，暂无新预警');
      }
    } catch (error) {
      console.error('检查预警失败:', error);
      setResultMessage('检测失败，请稍后重试');
    } finally {
      setIsCheckingAlerts(false);
      setTimeout(() => setResultMessage(null), 3000);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="text-xl font-bold text-gray-900">股票预警</h1>
          <div className="flex items-center gap-2">
            {alerts.length > 0 && (
              <button
                onClick={() => clearAllAlerts()}
                className="px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 rounded-lg transition"
              >
                清除全部
              </button>
            )}
            {unreadCount > 0 && (
              <span className="bg-red-500 text-white text-xs px-2 py-0.5 rounded-full">
                {unreadCount}
              </span>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-6">
        {/* 检查按钮 */}
        <button
          onClick={checkAlerts}
          disabled={isCheckingAlerts || watchlist.length === 0}
          className={cn(
            "w-full py-4 rounded-xl font-medium flex items-center justify-center gap-2 transition-all",
            isCheckingAlerts
              ? "bg-gray-300 text-gray-500 cursor-not-allowed"
              : "bg-blue-600 hover:bg-blue-700 text-white shadow-lg shadow-blue-200"
          )}
        >
          {isCheckingAlerts ? (
            <>
              <RefreshCw className="w-5 h-5 animate-spin" />
              正在检测预警...
            </>
          ) : (
            <>
              <RefreshCw className="w-5 h-5" />
              检查预警
            </>
          )}
        </button>

        {/* 结果提示 */}
        {resultMessage && (
          <div className={cn(
            "mt-4 p-3 rounded-lg text-center text-sm",
            resultMessage.includes('失败')
              ? "bg-red-50 text-red-600"
              : "bg-green-50 text-green-600"
          )}>
            {resultMessage}
          </div>
        )}

        {/* 预警列表 */}
        {groupedAlerts.length === 0 ? (
          <div className="mt-12 text-center py-20 text-gray-400">
            <AlertTriangle className="w-16 h-16 mx-auto mb-4 opacity-20" />
            <p className="text-lg">暂无预警</p>
            <p className="text-sm mt-2">添加自选股后点击上方按钮开始检测</p>
          </div>
        ) : (
          <div className="mt-6 space-y-4">
            {groupedAlerts.map((group) => (
              <div
                key={group.stockCode}
                className={cn(
                  "border-2 rounded-xl overflow-hidden transition-all hover:shadow-md",
                  getAlertLevelColor(group.worstLevel)
                )}
              >
                <div className="p-4">
                  {/* 股票头部 */}
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <h3 className="font-semibold">{group.stockName}</h3>
                      <p className="text-sm opacity-75">{group.stockCode}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm opacity-75">{group.alerts.length}条预警</span>
                      <button
                        onClick={() => clearAlerts(group.stockCode)}
                        className="p-1.5 hover:bg-black/10 rounded-lg transition"
                        title="清除此股预警"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  {/* 预警详情 */}
                  <div className="space-y-2">
                    {group.alerts.map((alert) => (
                      <div
                        key={alert.id}
                        className="flex items-start gap-2 text-sm p-2 bg-black/5 rounded-lg"
                      >
                        <span>
                          {alert.alertLevel === 'CRITICAL' ? '🔴' :
                            alert.alertLevel === 'WARNING' ? '🟡' : '🟢'}
                        </span>
                        <div className="flex-1">
                          <p>{alert.alertMessage}</p>
                          <p className="text-xs opacity-75 mt-0.5">建议: {alert.suggestion}</p>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* 时间 */}
                  <p className="text-xs opacity-50 mt-3">
                    {formatTime(group.latestTime)}
                  </p>
                </div>
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
            className="flex-1 py-3 flex flex-col items-center gap-1 text-blue-600"
          >
            <AlertTriangle className="w-6 h-6" />
            <span className="text-xs">预警</span>
          </a>
          <a
            href="/watchlist"
            className="flex-1 py-3 flex flex-col items-center gap-1 text-gray-400 hover:text-gray-600 transition"
          >
            <Plus className="w-6 h-6" />
            <span className="text-xs">自选</span>
          </a>
          <a
            href="/scanner"
            className="flex-1 py-3 flex flex-col items-center gap-1 text-gray-400 hover:text-gray-600 transition"
          >
            <RefreshCw className="w-6 h-6" />
            <span className="text-xs">筛选</span>
          </a>
        </div>
      </nav>
    </div>
  );
}