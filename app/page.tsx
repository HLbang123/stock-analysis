'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useStockStore } from '@/store';
import { getRealtimeQuote, getKLineSina } from '@/services/stockApi';
import { ALERT_RULES, checkAllRules } from '@/services/alertRules';
import { AlertRecord } from '@/types';
import { formatTime, cn, getAlertLevelColor } from '@/lib/utils';
import { buildUpdatedKLines } from '@/lib/stock-helpers';
import { AlertTriangle, RefreshCw, Trash2 } from 'lucide-react';
import { UpdateLog } from '@/components/UpdateLog';

export default function HomePage() {
  const router = useRouter();
  const { watchlist, alerts, isCheckingAlerts, clearAlerts, clearAllAlerts, setIsCheckingAlerts, rules } = useStockStore();

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
      const activeAlerts = stockAlerts.filter(a => !a.isExpired);
      const effectiveAlerts = activeAlerts.length > 0 ? activeAlerts : stockAlerts;
      const worstLevel = effectiveAlerts.some(a => a.alertLevel === 'CRITICAL')
        ? 'CRITICAL'
        : effectiveAlerts.some(a => a.alertLevel === 'WARNING')
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
      // 先将所有现有预警标记为"可能已过期"
      const currentAlerts = useStockStore.getState().alerts;
      const revivedIds = new Set<string>();
      const updatedAlerts = currentAlerts.map(a => ({ ...a, isExpired: true }));
      useStockStore.setState({ alerts: updatedAlerts });

      const allNewAlerts: AlertRecord[] = [];

      for (const stock of watchlist) {
        // 获取实时行情
        const quote = await getRealtimeQuote(stock.code);
        if (!quote) continue;

        // 获取K线数据
        const kLines = await getKLineSina(stock.code, 240, 120);

        if (kLines.length < 10) continue;

        const updatedKLines = buildUpdatedKLines(quote, kLines);

        // 检查规则
        const enabledRules = rules.filter(r => r.isEnabled);
        const results = checkAllRules(updatedKLines, quote, enabledRules);

        for (const result of results) {
          const rule = enabledRules.find(r => r.id === result.ruleId);
          if (rule) {
            // 检查是否已有相同预警（同一股票+同一规则）
            const existingKey = `${stock.code}-${result.ruleId}`;
            const existing = currentAlerts.find(a => `${a.stockCode}-${a.ruleId}` === existingKey);
            if (existing) {
              // 复活：这个预警仍然触发
              revivedIds.add(existing.id);
            } else {
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
                extraData: result.extraData,
              });
            }
          }
        }
      }

      // 更新现有预警：复活仍在触发的，保持已过期的
      const finalAlerts = useStockStore.getState().alerts.map(a => {
        if (revivedIds.has(a.id)) return { ...a, isExpired: false };
        return a; // 保持 isExpired: true
      });

      if (allNewAlerts.length > 0) {
        // 新预警插入前面
        useStockStore.setState({ alerts: [...allNewAlerts, ...finalAlerts] });
        const expiredCount = finalAlerts.filter(a => a.isExpired).length;
        const msg = `发现 ${allNewAlerts.length} 条新预警`;
        setResultMessage(expiredCount > 0 ? `${msg}，${expiredCount} 条已消失` : msg);
      } else {
        const expiredCount = finalAlerts.filter(a => a.isExpired).length;
        useStockStore.setState({ alerts: finalAlerts });
        setResultMessage(expiredCount > 0 ? `无新预警，${expiredCount} 条信号已消失` : '暂无新预警');
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
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-1">
          <UpdateLog />
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">预警</h1>
        </div>
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
                onClick={() => router.push(`/stock/${group.stockCode}`)}
                className={cn(
                  "border-2 rounded-xl overflow-hidden transition-all hover:shadow-md cursor-pointer",
                  group.alerts.every(a => a.isExpired) ? "opacity-50 border-gray-300" : getAlertLevelColor(group.worstLevel)
                )}
              >
                <div className="p-4">
                  {/* 股票头部 */}
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="font-semibold">{group.stockName}</h3>
                        {group.alerts.some(a => !a.isExpired && a.triggeredAt > Date.now() - 5000) && (
                          <span className="text-xs bg-green-500 text-white px-1.5 py-0.5 rounded font-bold">NEW</span>
                        )}
                        {group.alerts.every(a => a.isExpired) && (
                          <span className="text-xs bg-gray-300 text-gray-600 px-1.5 py-0.5 rounded">已消失</span>
                        )}
                      </div>
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
                        className={cn(
                          "flex items-start gap-2 text-sm p-2 rounded-lg",
                          alert.isExpired ? "bg-gray-100 opacity-60" : "bg-black/5"
                        )}
                      >
                        <span>
                          {alert.isExpired ? '⚪' :
                            alert.alertLevel === 'CRITICAL' ? '🔴' :
                            alert.alertLevel === 'WARNING' ? '🟡' : '🟢'}
                        </span>
                        <div className={cn("flex-1", alert.isExpired && "line-through")}>
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
    </div>
  );
}