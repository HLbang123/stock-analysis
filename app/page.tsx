'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useStockStore } from '@/store';
import { getRealtimeQuote, getKLineSina, getChipData } from '@/services/stockApi';
import { ALERT_RULES, checkAllRules, isBuyRule, REFERENCE_RULE_IDS, buyRuleWeight } from '@/services/alertRules';
import { AlertRecord } from '@/types';
import { formatTime, cn } from '@/lib/utils';
import { buildUpdatedKLines } from '@/lib/stock-helpers';
import { AlertTriangle, Trash2, BookOpen } from 'lucide-react';
import { UpdateLog } from '@/components/UpdateLog';
import { AlertRulesModal } from '@/components/AlertRulesModal';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';

/** 买入共振强度档位：按买入信号加权分(A级=2/B级=1)映射到情绪档位 */
const buyTier = (score: number) => {
  if (score >= 4) return { label: '强烈共振', dot: 'bg-[var(--color-up)]', cls: 'bg-[var(--color-up)] text-white border-transparent' };
  if (score === 3) return { label: '较强看多', dot: 'bg-[var(--color-up)]', cls: 'bg-[var(--color-up-soft)] text-[var(--color-up)] border-[var(--color-up-border)]' };
  if (score === 2) return { label: '温和看多', dot: 'bg-[var(--color-up)]/60', cls: 'bg-[var(--color-up-soft)]/60 text-[var(--color-up)] border-[var(--color-up-border)]' };
  return { label: '弱观察', dot: 'bg-[var(--color-warning)]', cls: 'bg-[var(--color-warning-soft)] text-[var(--color-warning)] border-[var(--color-warning)]/30' };
};

/** 该条买入预警是否为"放量确认"（读 extraData 的 volConfirmed，R05/R06/R09/R10/R11/R12/R13 写入） */
const hasVolumeConfirmed = (a: AlertRecord): boolean => {
  if (!a.extraData) return false;
  try { return JSON.parse(a.extraData)?.volConfirmed === true; } catch { return false; }
};

/** 严重度排序权重：CRITICAL 最前 */
const LEVEL_RANK: Record<string, number> = { CRITICAL: 0, WARNING: 1, INFO: 2 };

/** 整卡按信号方向着色（用户约定：买=红、卖=绿；同组买卖都有时卖出优先，风控先行） */
const groupTone = (group: { alerts: AlertRecord[] }): string => {
  const active = group.alerts.filter(a => !a.isExpired);
  if (active.length === 0) {
    return 'bg-gray-50 dark:bg-gray-800/40 border-gray-200 dark:border-gray-700 opacity-50';
  }
  const hasSell = active.some(a => !isBuyRule(a.ruleId) && !REFERENCE_RULE_IDS.has(a.ruleId));
  if (hasSell) return 'bg-[var(--color-down-soft)] border-[var(--color-down-border)]';
  const hasBuy = active.some(a => isBuyRule(a.ruleId) && !REFERENCE_RULE_IDS.has(a.ruleId));
  if (hasBuy) return 'bg-[var(--color-up-soft)] border-[var(--color-up-border)]';
  // 仅参考级弱提醒（R14/R15 筹码峰）
  return 'bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700';
};

export default function HomePage() {
  const router = useRouter();
  const { watchlist, alerts, isCheckingAlerts, clearAlerts, clearAllAlerts, setIsCheckingAlerts } = useStockStore();

  const [resultMessage, setResultMessage] = useState<string | null>(null);
  const [buyExpanded, setBuyExpanded] = useState<Set<string>>(new Set());
  const [showRules, setShowRules] = useState(false);
  const toggleBuyExpand = (code: string) => {
    setBuyExpanded(prev => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code); else next.add(code);
      return next;
    });
  };

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
      const buyAlerts = stockAlerts.filter(a => isBuyRule(a.ruleId) && !REFERENCE_RULE_IDS.has(a.ruleId));
      const sellAlerts = stockAlerts.filter(a => !isBuyRule(a.ruleId) && !REFERENCE_RULE_IDS.has(a.ruleId));
      const referenceAlerts = stockAlerts.filter(a => REFERENCE_RULE_IDS.has(a.ruleId));
      const buyScore = buyAlerts.reduce((s, a) => s + buyRuleWeight(a.ruleId), 0);
      // 量能维度：至少一条买入信号为"放量确认" → 档位 +1
      const buyVolumeBoost = buyAlerts.some(hasVolumeConfirmed) ? 1 : 0;
      const tierScore = buyScore + buyVolumeBoost;
      // 卡面结论方向：有有效卖出信号时卖出优先（与 groupTone 同口径），此时头部不再挂红色看多徽章，避免红绿打架
      const hasActiveSell = activeAlerts.some(a => !isBuyRule(a.ruleId) && !REFERENCE_RULE_IDS.has(a.ruleId));
      return {
        stockCode,
        stockName: stockAlerts[0].stockName,
        alerts: stockAlerts,
        buyAlerts,
        sellAlerts,
        referenceAlerts,
        buyResonance: buyAlerts.length >= 2,
        buyScore,
        buyVolumeBoost,
        tierScore,
        buyTier: tierScore > 0 && !hasActiveSell ? buyTier(tierScore) : null,
        worstLevel,
        latestTime: Math.max(...stockAlerts.map(a => a.triggeredAt))
      };
    }).sort((a, b) => {
      // 已消失的信号组沉底；有效组按严重度(CRITICAL>WARNING>INFO) → 买入强度 → 最新时间
      const aGone = a.alerts.every(x => x.isExpired);
      const bGone = b.alerts.every(x => x.isExpired);
      if (aGone !== bGone) return aGone ? 1 : -1;
      const lr = (LEVEL_RANK[a.worstLevel] ?? 3) - (LEVEL_RANK[b.worstLevel] ?? 3);
      if (lr !== 0) return lr;
      if (a.tierScore !== b.tierScore) return b.tierScore - a.tierScore;
      return b.latestTime - a.latestTime;
    });
  }, [alerts]);

  // 未读数
  const unreadCount = alerts.filter(a => !a.isRead).length;

  // 单条预警行渲染：左侧色条按方向着色（买红/卖绿/参考黄），弱化 emoji；
  // 行底用半透明白，叠在整卡着色上保持可读
  const renderAlertRow = (alert: AlertRecord) => {
    const toneBar = alert.isExpired
      ? 'bg-gray-300 dark:bg-gray-600'
      : REFERENCE_RULE_IDS.has(alert.ruleId)
        ? 'bg-[var(--color-warning)]'
        : isBuyRule(alert.ruleId)
          ? 'bg-[var(--color-up)]'
          : 'bg-[var(--color-down)]';
    // 文案里烘焙的方向 emoji（🔴/🟢/🟡/⚠️）与左侧色条、整卡着色重复，渲染时剥掉
    const message = alert.alertMessage.replace(/^(🔴|🟢|🟡|🔵|⚠️)\s*/, '');
    return (
      <div
        key={alert.id}
        className={cn(
          "flex items-stretch gap-2.5 text-sm py-2 px-2.5 rounded-[var(--radius-md)]",
          alert.isExpired ? "bg-white/40 dark:bg-gray-900/30 opacity-60" : "bg-white/70 dark:bg-gray-900/50"
        )}
      >
        <span className={cn("w-1 rounded-full shrink-0", toneBar)} />
        <div className={cn("flex-1 min-w-0", alert.isExpired && "line-through")}>
          <p className="text-gray-800 dark:text-gray-200">{message}</p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">建议：{alert.suggestion}</p>
        </div>
      </div>
    );
  };

  // 检查预警
  const checkAlerts = async () => {
    if (watchlist.length === 0) {
      setResultMessage('请先添加自选标的');
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

        // 筹码分布（DB 取数，失败返回 null，R14/R15 不触发）
        const chip = await getChipData(stock.code);

        // 检查规则
        const enabledRules = ALERT_RULES.filter(r => r.isEnabled);
        const results = checkAllRules(updatedKLines, quote, enabledRules, chip);

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
      {/* 页面头部：标题 + 操作 */}
      <PageHeader
        title="预警"
        icon={<UpdateLog />}
        badge={unreadCount > 0 && (
          <span className="bg-[var(--color-danger)] text-white text-xs px-2 py-0.5 rounded-full font-medium">
            {unreadCount}
          </span>
        )}
        actions={
          <>
            <button
              onClick={() => setShowRules(true)}
              className="flex items-center gap-1 px-3 py-1.5 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-[var(--radius-md)] transition"
              title="查看预警规则说明"
            >
              <BookOpen className="w-4 h-4" />
              规则说明
            </button>
            {alerts.length > 0 && (
              <button
                onClick={() => clearAllAlerts()}
                className="px-3 py-1.5 text-sm text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)] rounded-[var(--radius-md)] transition"
              >
                清除全部
              </button>
            )}
          </>
        }
      />

      {/* 操作区 */}
      <Button
        onClick={checkAlerts}
        disabled={isCheckingAlerts || watchlist.length === 0}
        loading={isCheckingAlerts}
        variant="accent"
        size="lg"
        className="w-full"
      >
        {isCheckingAlerts ? '正在检测预警...' : '检查预警'}
      </Button>

      {/* 结果提示 */}
      {resultMessage && (
        <div className={cn(
          "mt-4 p-3 rounded-[var(--radius-md)] text-center text-sm",
          resultMessage.includes('失败')
            ? "bg-[var(--color-danger-soft)] text-[var(--color-danger)]"
            : "bg-[var(--color-down-soft)] text-[var(--color-down)]"
        )}>
          {resultMessage}
        </div>
      )}

        {/* 预警列表 */}
        {groupedAlerts.length === 0 ? (
          <div className="mt-12 text-center py-20 text-gray-400">
            <AlertTriangle className="w-16 h-16 mx-auto mb-4 opacity-20" />
            <p className="text-lg">暂无预警</p>
            <p className="text-sm mt-2">添加自选后点击上方按钮开始检测</p>
          </div>
        ) : (
          <div className="mt-[var(--space-section)] space-y-3">
            {groupedAlerts.map((group) => (
              <div
                key={group.stockCode}
                onClick={() => router.push(`/stock/${group.stockCode}`)}
                className={cn(
                  "border-2 rounded-[var(--radius-lg)] shadow-[var(--shadow-card)] overflow-hidden transition-shadow hover:shadow-[var(--shadow-hover)] cursor-pointer",
                  groupTone(group)
                )}
              >
                {/* 扫读层：股名 + 强度 + 时间，一眼获取关键信息 */}
                <div className="px-4 pt-3.5 pb-3 border-b border-black/5 dark:border-white/10">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <h3 className="font-semibold text-gray-900 dark:text-white truncate">{group.stockName}</h3>
                      {group.alerts.some(a => !a.isExpired && a.triggeredAt > Date.now() - 5000) && (
                        <span className="text-[10px] bg-[var(--color-up)] text-white px-1.5 py-0.5 rounded font-bold shrink-0">NEW</span>
                      )}
                      {group.alerts.every(a => a.isExpired) && (
                        <span className="text-[10px] bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-400 px-1.5 py-0.5 rounded shrink-0">已消失</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {group.buyTier && (
                        <span
                          title={group.buyVolumeBoost ? '买入强度：含放量确认 +1档' : '买入强度'}
                          className={cn('text-xs px-2 py-0.5 rounded-[var(--radius-sm)] border font-medium whitespace-nowrap flex items-center gap-1', group.buyTier.cls)}
                        >
                          <span className={cn('w-1.5 h-1.5 rounded-full', group.buyTier.dot)} />
                          {group.buyTier.label}
                        </span>
                      )}
                      <button
                        onClick={(e) => { e.stopPropagation(); clearAlerts(group.stockCode); }}
                        className="p-1 text-gray-400 hover:text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)] rounded-[var(--radius-sm)] transition"
                        title="清除该标的预警"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center justify-between mt-1">
                    <p className="text-xs text-gray-400">{group.stockCode}</p>
                    <p className="text-xs text-gray-400">{formatTime(group.latestTime)}</p>
                  </div>
                </div>

                {/* 明细层：信号列表 */}
                <div className="px-4 py-3 space-y-1.5">
                  {/* 卖出/风险信号 */}
                  {group.sellAlerts.map(alert => renderAlertRow(alert))}

                  {/* 参考级弱提醒（R14/R15 筹码峰） */}
                  {group.referenceAlerts.map(alert => renderAlertRow(alert))}

                  {/* 买入信号：≥2 条聚合成"共振"（中性边框，方向感只留标题红点，避免绿卡上一整块红） */}
                  {group.buyResonance ? (
                    <div className="rounded-[var(--radius-md)] bg-white/70 dark:bg-gray-900/50 border border-black/10 dark:border-white/10 overflow-hidden">
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); toggleBuyExpand(group.stockCode); }}
                        className="w-full flex items-center gap-2 text-sm px-2.5 py-2 text-left hover:bg-black/5 dark:hover:bg-white/5 transition"
                      >
                        <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-up)] shrink-0" />
                        <span className="font-medium text-[var(--color-up)] whitespace-nowrap">买入共振 · {group.buyAlerts.length}条</span>
                        <span className="text-xs text-gray-500 dark:text-gray-400 truncate">
                          {group.buyAlerts.map(a => a.ruleName).join(' / ')}
                        </span>
                        <span className="ml-auto text-xs text-gray-400 whitespace-nowrap">
                          {buyExpanded.has(group.stockCode) ? '收起 ▲' : '展开 ▼'}
                        </span>
                      </button>
                      {buyExpanded.has(group.stockCode) && (
                        <div className="space-y-1 px-2.5 pb-2.5">
                          {group.buyAlerts.map(alert => renderAlertRow(alert))}
                        </div>
                      )}
                    </div>
                  ) : (
                    group.buyAlerts.map(alert => renderAlertRow(alert))
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

      {showRules && <AlertRulesModal onClose={() => setShowRules(false)} />}
    </div>
  );
}