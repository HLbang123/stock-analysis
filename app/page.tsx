'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useStockStore } from '@/store';
import { getKLineSina, getBatchQuotes, getBatchKLines, getChipData } from '@/services/stockApi';
import { ALERT_RULES, checkAllRules, isBuyRule, REFERENCE_RULE_IDS, buyRuleWeight, isStrongSellAlert, severityAlertLevel } from '@/services/alertRules';
import { AlertRecord } from '@/types';
import { formatTime, cn } from '@/lib/utils';
import { buildUpdatedKLines } from '@/lib/stock-helpers';
import { isETF } from '@/lib/identify';
import { AlertTriangle, Trash2, BarChart3, Cloud, Share2 } from 'lucide-react';
import { UpdateLog } from '@/components/UpdateLog';
import { AlertRulesModal } from '@/components/AlertRulesModal';
import { ReviewModal } from '@/components/ReviewModal';
import { SyncModal } from '@/components/SyncModal';
import { ShareModal } from '@/components/ShareModal';
import { useSyncStore } from '@/store/sync-store';
import { useUiStore } from '@/store/ui-store';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { ALL_GROUP_ID } from '@/components/GroupBar';

/** 买入共振强度档位：按买入信号加权分(A级=2/B级=1)映射到情绪档位 */
const buyTier = (score: number) => {
  if (score >= 4) return { label: '强烈共振', dot: 'bg-[var(--color-up)]', cls: 'bg-[var(--color-up)] text-white border-transparent' };
  if (score === 3) return { label: '较强看多', dot: 'bg-[var(--color-up)]', cls: 'bg-[var(--color-up-soft)] text-[var(--color-up)] border-[var(--color-up-border)]' };
  if (score === 2) return { label: '温和看多', dot: 'bg-[var(--color-up)]/60', cls: 'bg-[var(--color-up-soft)]/60 text-[var(--color-up)] border-[var(--color-up-border)]' };
  return { label: '弱观察', dot: 'bg-[var(--color-warning)]', cls: 'bg-[var(--color-warning-soft)] text-[var(--color-warning)] border-[var(--color-warning)]/30' };
};

/** 该条买入预警是否为"放量确认"（读 extraData 的 volConfirmed，R04/R05/R08/R09/R10/R11/R12 写入） */
const hasVolumeConfirmed = (a: AlertRecord): boolean => {
  if (!a.extraData) return false;
  try { return JSON.parse(a.extraData)?.volConfirmed === true; } catch { return false; }
};

/** 严重度排序权重：CRITICAL 最前 */
const LEVEL_RANK: Record<string, number> = { CRITICAL: 0, WARNING: 1, INFO: 2 };

/** 整卡按信号方向着色（用户约定：买=红、卖=绿）。仅强卖出（isStrongSellAlert，阶梯主信号 sev≥3
 *  或 R03 等单信号规则）染绿整卡；弱卖出提醒（巨量异动/涨停封板/跌破5日线等）不染卡——
 *  行内绿条已足以提示，弱提醒不应压过买入共振 */
const groupTone = (group: { alerts: AlertRecord[] }): string => {
  const hasStrongSell = group.alerts.some(a => isStrongSellAlert(a.ruleId, a.extraData));
  if (hasStrongSell) return 'bg-[var(--color-down-soft)] border-[var(--color-down-border)]';
  const hasBuy = group.alerts.some(a => isBuyRule(a.ruleId) && !REFERENCE_RULE_IDS.has(a.ruleId));
  if (hasBuy) return 'bg-[var(--color-up-soft)] border-[var(--color-up-border)]';
  // 仅弱卖出提醒 / 参考级弱提醒（R13/R14 筹码峰）
  return 'bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700';
};

export default function HomePage() {
  const router = useRouter();
  const { watchlist, groups, alerts, isCheckingAlerts, clearAlerts, clearAllAlerts, setIsCheckingAlerts } = useStockStore();

  const [resultMessage, setResultMessage] = useState<string | null>(null);
  const [buyExpanded, setBuyExpanded] = useState<Set<string>>(new Set());
  // 分组筛选位置存 ui-store：钻详情返回后仍在原分组（useState 会被重挂载重置）
  const selectedGroupId = useUiStore(s => s.homeAlertGroupId);
  const setSelectedGroupId = useUiStore(s => s.setHomeAlertGroupId);
  const [showRules, setShowRules] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const [showSync, setShowSync] = useState(false);
  const [showShare, setShowShare] = useState(false);
  // 周报未读角标：周五 cron 更新后本地记"上次已读的 generatedAt"，新的周报生成就亮角标，点开即清
  const [weeklyLatestAt, setWeeklyLatestAt] = useState<string>('');
  const [weeklyUnread, setWeeklyUnread] = useState(false);
  const WEEKLY_READ_KEY = 'weekly-review-last-read';
  useEffect(() => {
    fetch('/api/weekly-review?meta=1')
      .then((r) => r.json())
      .then((data) => {
        const generatedAt = data?.review?.generatedAt as string | undefined;
        if (!generatedAt) return;
        setWeeklyLatestAt(generatedAt);
        try {
          const last = localStorage.getItem(WEEKLY_READ_KEY);
          setWeeklyUnread(!last || generatedAt > last);
        } catch { setWeeklyUnread(false); }
      })
      .catch(() => { /* 静默 */ });
  }, []);
  const openReview = () => {
    setShowReview(true);
    if (weeklyUnread) {
      setWeeklyUnread(false);
      try { localStorage.setItem(WEEKLY_READ_KEY, weeklyLatestAt); } catch { /* ignore */ }
    }
  };
  // 云同步引导条：有自选但未开启且未关闭过提示时显示（中性措辞，换机用户应走"配对码恢复"而非"开启"）
  const syncEnabled = useSyncStore((s) => s.enabled);
  const bannerDismissed = useSyncStore((s) => s.bannerDismissed);
  const toggleBuyExpand = (code: string) => {
    setBuyExpanded(prev => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code); else next.add(code);
      return next;
    });
  };

  // 分组预警（首页只展示有效预警；过期预警属历史，去标的详情页「历史预警」查看）
  const groupedAlerts = useMemo(() => {
    const groups = new Map<string, AlertRecord[]>();
    alerts.forEach(alert => {
      const key = alert.stockCode;
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(alert);
    });

    return Array.from(groups.entries())
      .map(([stockCode, stockAlerts]) => {
        const activeAlerts = stockAlerts.filter(a => !a.isExpired);
        if (activeAlerts.length === 0) return null;
        // 有效级别：R01/R02 阶梯按主信号 severity 分级（巨量异动等弱提醒不再以 CRITICAL 排顶）
        const effLevel = (a: AlertRecord) => severityAlertLevel(a.ruleId, a.extraData, a.alertLevel);
        const worstLevel = activeAlerts.some(a => effLevel(a) === 'CRITICAL')
          ? 'CRITICAL'
          : activeAlerts.some(a => effLevel(a) === 'WARNING')
            ? 'WARNING'
            : 'INFO';
        const buyAlerts = activeAlerts.filter(a => isBuyRule(a.ruleId) && !REFERENCE_RULE_IDS.has(a.ruleId));
        const sellAlerts = activeAlerts.filter(a => !isBuyRule(a.ruleId) && !REFERENCE_RULE_IDS.has(a.ruleId));
        const referenceAlerts = activeAlerts.filter(a => REFERENCE_RULE_IDS.has(a.ruleId));
        const buyScore = buyAlerts.reduce((s, a) => s + buyRuleWeight(a.ruleId), 0);
        // 量能维度：至少一条买入信号为"放量确认" → 档位 +1
        const buyVolumeBoost = buyAlerts.some(hasVolumeConfirmed) ? 1 : 0;
        const tierScore = buyScore + buyVolumeBoost;
        // 卡面结论方向：有强卖出信号时卖出优先（与 groupTone 同口径），此时头部不挂看多徽章，避免红绿打架；
        // 弱卖出提醒（巨量异动/涨停封板等）不摘徽章——不应对买入共振有一票否决权
        const hasStrongSell = activeAlerts.some(a => isStrongSellAlert(a.ruleId, a.extraData));
        return {
          stockCode,
          stockName: stockAlerts[0].stockName,
          alerts: activeAlerts,
          buyAlerts,
          sellAlerts,
          referenceAlerts,
          buyResonance: buyAlerts.length >= 2,
          buyScore,
          buyVolumeBoost,
          tierScore,
          buyTier: tierScore > 0 && !hasStrongSell ? buyTier(tierScore) : null,
          worstLevel,
          latestTime: Math.max(...activeAlerts.map(a => a.triggeredAt))
        };
      })
      .filter((g): g is NonNullable<typeof g> => g !== null)
      .sort((a, b) => {
        // 有效组按严重度(CRITICAL>WARNING>INFO) → 买入强度 → 最新时间
        const lr = (LEVEL_RANK[a.worstLevel] ?? 3) - (LEVEL_RANK[b.worstLevel] ?? 3);
        if (lr !== 0) return lr;
        if (a.tierScore !== b.tierScore) return b.tierScore - a.tierScore;
        return b.latestTime - a.latestTime;
      });
  }, [alerts]);

  // 自选分组过滤：标的 → 所属组集合（多组映射；不在任何组 = 只在「全部」下出现，与自选页口径一致）
  const groupIdsOfCode = useMemo(() => {
    const m = new Map<string, Set<string>>();
    groups.forEach(g => g.stockCodes.forEach(c => {
      if (!m.has(c)) m.set(c, new Set());
      m.get(c)!.add(g.id);
    }));
    return m;
  }, [groups]);
  const visibleAlerts = selectedGroupId === ALL_GROUP_ID
    ? groupedAlerts
    : groupedAlerts.filter(g => groupIdsOfCode.get(g.stockCode)?.has(selectedGroupId));
  const alertCountOf = (id: string) =>
    id === ALL_GROUP_ID
      ? groupedAlerts.length
      : groupedAlerts.filter(g => groupIdsOfCode.get(g.stockCode)?.has(id)).length;

  // 选中组被删除时自动回退「全部」
  useEffect(() => {
    if (selectedGroupId !== ALL_GROUP_ID && !groups.some(g => g.id === selectedGroupId)) {
      setSelectedGroupId(ALL_GROUP_ID);
    }
  }, [groups, selectedGroupId]);

  // 未读数（badge 已移除，保留口径供后续扩展）

  // 单条预警行渲染：左侧色条按方向着色（买红/卖绿/参考黄），弱化 emoji；
  // 行底用半透明白，叠在整卡着色上保持可读
  const renderAlertRow = (alert: AlertRecord) => {
    const toneBar = REFERENCE_RULE_IDS.has(alert.ruleId)
      ? 'bg-[var(--color-warning)]'
      : isBuyRule(alert.ruleId)
        ? 'bg-[var(--color-up)]'
        : 'bg-[var(--color-down)]';
    // 阶梯弱提醒（sev≤2，如巨量异动）色条半透明：与强卖出（实心）拉开视觉区分度
    let weakLadder = false;
    if (alert.ruleId === 'R01' || alert.ruleId === 'R02') {
      try {
        const sev = JSON.parse(alert.extraData ?? '{}')?.sev;
        weakLadder = typeof sev === 'number' && sev < 3;
      } catch { /* 旧数据无 sev：按强处理，保持实心 */ }
    }
    // 文案里烘焙的方向 emoji（🔴/🟢/🟡/⚠️）与左侧色条、整卡着色重复，渲染时剥掉
    const message = alert.alertMessage.replace(/^(🔴|🟢|🟡|🔵|⚠️)\s*/, '');
    return (
      <div
        key={alert.id}
        className="flex items-stretch gap-2.5 text-sm py-2 px-2.5 rounded-[var(--radius-md)] bg-white/70 dark:bg-gray-900/50"
      >
        <span className={cn("w-1 rounded-full shrink-0", toneBar, weakLadder && 'opacity-40')} />
        <div className="flex-1 min-w-0">
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

    // 触发明细落库行（try 外声明，finally 统一静默写，失败不影响预警流程）
    const triggerRows: { tsCode: string; stockName: string; ruleId: string; subLabel: string; barDate: string }[] = [];
    const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(/-/g, '');

    try {
      // 预取当日涨跌停价表（精确涨停判定；失败回落规则推算）
      let limitMap: Record<string, { up: number; down: number }> | null = null;
      try {
        const lr = await fetch(`/api/stock-limit?tradeDate=${todayStr}`);
        const ld = await lr.json();
        if (ld?.map) limitMap = ld.map;
      } catch { /* 静默：回落规则推算 */ }

      // 先将所有现有预警标记为"可能已过期"
      const currentAlerts = useStockStore.getState().alerts;
      const revivedIds = new Set<string>();
      // 复活记录的分级元数据（extraData.sev / alertLevel）随最新触发刷新——否则改动前无 sev 的旧记录
      // 会被 isStrongSellAlert 保守按强卖出处理，弱提醒一直染绿整卡；消息内容仍保留首次触发快照
      const revivedMeta = new Map<string, { extraData?: string; alertLevel: AlertRecord['alertLevel'] }>();
      const updatedAlerts = currentAlerts.map(a => ({ ...a, isExpired: true }));
      useStockStore.setState({ alerts: updatedAlerts });

      const allNewAlerts: AlertRecord[] = [];

      // 批量预取全自选行情+日K（1 次行情 + 1 次K线请求，替代逐只打上游；400+ 自选不再扇出）
      const codes = watchlist.map(s => s.code);
      const [quoteMap, klineMap] = await Promise.all([
        getBatchQuotes(codes),
        getBatchKLines(codes, 120),
      ]);

      // 筹码并发预取（8 并发；ETF 不适用直接跳过。服务端有 30min 缓存，二次检查近乎内存读）
      const chipMap = new Map<string, Awaited<ReturnType<typeof getChipData>>>();
      const chipCodes = codes.filter(c => !isETF(c));
      let chipIdx = 0;
      await Promise.all(Array.from({ length: Math.min(8, chipCodes.length) }, async () => {
        while (chipIdx < chipCodes.length) {
          const c = chipCodes[chipIdx++];
          chipMap.set(c, await getChipData(c));
        }
      }));

      for (const stock of watchlist) {
        // 获取实时行情
        const quote = quoteMap.get(stock.code);
        if (!quote) continue;

        // 获取K线数据（DB 批量未覆盖的品种如 ETF 回落上游逐只拉）
        let kLines = klineMap.get(stock.code) ?? [];
        if (kLines.length === 0) {
          kLines = await getKLineSina(stock.code, 240, 120);
        }

        if (kLines.length < 10) continue;

        const updatedKLines = buildUpdatedKLines(quote, kLines);

        // 筹码分布（预取结果；null 时 R13/R14 不触发）
        const chip = chipMap.get(stock.code) ?? null;

        // 检查规则
        const enabledRules = ALERT_RULES.filter(r => r.isEnabled);
        const results = checkAllRules(updatedKLines, quote, enabledRules, chip, limitMap, isETF(stock.code));

        for (const result of results) {
          const rule = enabledRules.find(r => r.id === result.ruleId);
          if (rule) {
            // 落库行：R01/R02 展开 extraData.triggered 各子信号一行；其余规则用规则名
            const subs: string[] = [];
            try { const ex = JSON.parse(result.extraData ?? '{}'); subs.push(...(ex.triggered ?? [])); } catch { /* ignore */ }
            for (const s of (subs.length ? subs : [rule.name])) {
              triggerRows.push({ tsCode: stock.code, stockName: stock.name || quote.name, ruleId: result.ruleId!, subLabel: s, barDate: todayStr });
            }
            // 复活键 = 股票+规则+主信号。R01/R02 是多子信号规则(涨停封板/巨量见顶/...共用一个 ruleId)，
            // 若只匹配规则级，今日任意子信号触发都会复活昨日不同子信号的旧预警——内容仍显示昨日数据
            // (有研新材 2026-08-10「涨停封板(48.17)」误报根因：今日巨量见顶复活了昨日真涨停的旧记录)。
            const mainSub = (subs.length ? subs : [rule.name])[0];
            const existing = currentAlerts.find((a) => {
              if (a.stockCode !== stock.code || a.ruleId !== result.ruleId) return false;
              // 单信号规则（R04-R12 买入等，无子信号）：规则级匹配即可复活——否则永不复活、每次检查都新建
              // 造成同信号"有效+划痕线"并存（2026-08-10 修复：复活键细化到子信号级只该作用于 R01/R02 阶梯）
              if (subs.length === 0) return true;
              let oldSub = '';
              try { const ex = JSON.parse(a.extraData ?? '{}'); oldSub = (ex.triggered ?? [])[0] ?? ''; } catch { /* ignore */ }
              // 旧数据无 extraData：回落规则名，与任何子信号不相等 → 视为新预警
              return oldSub === mainSub;
            });
            if (existing) {
              // 复活：这个预警仍然触发（分级元数据随最新结果刷新）
              revivedIds.add(existing.id);
              revivedMeta.set(existing.id, {
                extraData: result.extraData,
                alertLevel: severityAlertLevel(result.ruleId, result.extraData, rule.level),
              });
            } else {
              allNewAlerts.push({
                id: `${Date.now()}-${stock.code}-${result.ruleId}`,
                stockCode: stock.code,
                stockName: stock.name || quote.name,
                ruleId: result.ruleId!,
                ruleName: rule.name,
                alertLevel: severityAlertLevel(result.ruleId, result.extraData, rule.level),
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
        const meta = revivedMeta.get(a.id);
        if (revivedIds.has(a.id)) {
          return {
            ...a,
            isExpired: false,
            extraData: meta?.extraData ?? a.extraData,
            alertLevel: meta?.alertLevel ?? a.alertLevel,
          };
        }
        return a; // 保持 isExpired: true
      });

      // 清理被有效预警遮蔽的过期重复（同股票+规则+主信号只留一份）：复活键细化到子信号级曾导致
      // 单信号规则永不复活、每次检查都新建，累积"有效+划痕线"并存（2026-08-10 修复，含清存量）。
      // R01/R02 按主信号区分，不同子信号互不遮蔽、保留过期历史。
      const subOf = (x: Pick<AlertRecord, 'stockCode' | 'ruleId' | 'ruleName' | 'extraData'>) => {
        try { const ex = JSON.parse(x.extraData ?? '{}'); const t = ex.triggered; if (Array.isArray(t) && t[0]) return String(t[0]); } catch { /* ignore */ }
        return x.ruleName;
      };
      const keyOf = (x: AlertRecord) => `${x.stockCode}|${x.ruleId}|${subOf(x)}`;
      const activeKeys = new Set<string>();
      for (const a of finalAlerts) if (!a.isExpired) activeKeys.add(keyOf(a));
      for (const a of allNewAlerts) activeKeys.add(keyOf(a));
      const cleanedAlerts = finalAlerts.filter(a => !a.isExpired || !activeKeys.has(keyOf(a)));

      if (allNewAlerts.length > 0) {
        // 新预警插入前面
        useStockStore.setState({ alerts: [...allNewAlerts, ...cleanedAlerts] });
        const expiredCount = cleanedAlerts.filter(a => a.isExpired).length;
        const msg = `发现 ${allNewAlerts.length} 条新预警`;
        setResultMessage(expiredCount > 0 ? `${msg}，${expiredCount} 条已消失` : msg);
      } else {
        const expiredCount = cleanedAlerts.filter(a => a.isExpired).length;
        useStockStore.setState({ alerts: cleanedAlerts });
        setResultMessage(expiredCount > 0 ? `无新预警，${expiredCount} 条信号已消失` : '暂无新预警');
      }
    } catch (error) {
      console.error('检查预警失败:', error);
      setResultMessage('检测失败，请稍后重试');
    } finally {
      // 触发明细静默落库（失败不阻断；同日同信号 upsert 去重）
      if (triggerRows.length > 0) {
        fetch('/api/alerts/triggers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ triggers: triggerRows }),
        }).catch(() => {});
      }
      setIsCheckingAlerts(false);
      setTimeout(() => setResultMessage(null), 3000);
    }
  };

  return (
    <div>
      {/* 页面头部：标题 + 操作 */}
      <PageHeader
        title="预警"
        icon={<UpdateLog onShowRules={() => setShowRules(true)} />}
        actions={
          <>
            <button
              onClick={openReview}
              className="relative flex items-center gap-1 px-3 py-1.5 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-[var(--radius-md)] transition"
              title="复盘：周报与胜率统计"
            >
              <BarChart3 className="w-4 h-4" />
              复盘
              {weeklyUnread && (
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-[var(--color-danger)] animate-pulse" />
              )}
            </button>
            <button
              onClick={() => setShowSync(true)}
              className="flex items-center gap-1 px-3 py-1.5 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-[var(--radius-md)] transition"
              title="云同步：多设备共享数据"
            >
              <Cloud className="w-4 h-4" />
              同步
            </button>
            <button
              onClick={() => setShowShare(true)}
              className="flex items-center gap-1 px-3 py-1.5 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-[var(--radius-md)] transition"
              title="分享自选给群友"
            >
              <Share2 className="w-4 h-4" />
              分享
            </button>
          </>
        }
      />

      {/* 云同步引导条（一次性，可关闭） */}
      {watchlist.length > 0 && !syncEnabled && !bannerDismissed && (
        <div className="mt-3 flex items-center gap-2 px-3 py-2.5 rounded-[var(--radius-md)] bg-[var(--color-brand-soft)]/60 dark:bg-[var(--color-brand-soft)]/30 text-sm">
          <Cloud className="w-4 h-4 text-[var(--color-brand)] shrink-0" />
          <span className="flex-1 text-gray-700 dark:text-gray-200">多设备共享自选、分组与 AI 配置</span>
          <button onClick={() => setShowSync(true)} className="text-xs text-[var(--color-accent)] hover:underline shrink-0">
            去设置
          </button>
          <button
            onClick={() => useSyncStore.getState().dismissBanner()}
            className="px-1 text-gray-400 hover:text-gray-600 shrink-0"
            aria-label="关闭"
          >
            ×
          </button>
        </div>
      )}

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

        {/* 预警列表：分组栏常驻（预警清空也能切组） */}
        <div className="mt-[var(--space-section)] space-y-3">
          {/* 清除全部：移出顶部 header（手机端头部太挤），与预警计数并列放列表上方；无预警时隐藏 */}
          {groupedAlerts.length > 0 && (
            <div className="flex items-center justify-between px-1">
              <span className="text-xs text-gray-400">
                {groupedAlerts.reduce((s, g) => s + g.alerts.length, 0)} 条预警
              </span>
              <button
                onClick={() => clearAllAlerts()}
                className="flex items-center gap-1 text-xs whitespace-nowrap text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)] px-2 py-1 rounded-[var(--radius-sm)] transition"
              >
                <Trash2 className="w-3.5 h-3.5" />
                清除全部
              </button>
            </div>
          )}

          {/* 分组过滤栏（有分组就显示，预警清空也可切组；计数=该组下有预警的标的数） */}
          {groups.length > 0 && (
              <div className="bg-white dark:bg-gray-900 rounded-xl p-2 shadow-sm flex items-center gap-1.5 overflow-x-auto">
                {[ALL_GROUP_ID, ...groups.map(g => g.id)].map(id => (
                  <button
                    key={id}
                    onClick={() => setSelectedGroupId(id)}
                    className={cn(
                      'shrink-0 px-3 py-1.5 rounded-lg text-sm whitespace-nowrap transition',
                      selectedGroupId === id
                        ? 'bg-blue-600 text-white'
                        : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800',
                    )}
                  >
                    {id === ALL_GROUP_ID ? '全部' : groups.find(g => g.id === id)?.name}
                    <span className={cn('ml-1.5 text-xs', selectedGroupId === id ? 'text-blue-100' : 'text-gray-400')}>
                      {alertCountOf(id)}
                    </span>
                  </button>
                ))}
              </div>
            )}

          {groupedAlerts.length === 0 ? (
            <div className="text-center py-20 text-gray-400">
              <AlertTriangle className="w-16 h-16 mx-auto mb-4 opacity-20" />
              <p className="text-lg">暂无预警</p>
              <p className="text-sm mt-2">添加自选后点击上方按钮开始检测</p>
            </div>
          ) : visibleAlerts.length === 0 ? (
            <div className="text-center py-12 text-gray-400 text-sm">该分组暂无预警</div>
          ) : visibleAlerts.map((group) => (
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
                      {group.alerts.some(a => a.triggeredAt > Date.now() - 5000) && (
                        <span className="text-[10px] bg-[var(--color-up)] text-white px-1.5 py-0.5 rounded font-bold shrink-0">NEW</span>
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

                  {/* 参考级弱提醒（R13/R14 筹码峰） */}
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

      {showRules && <AlertRulesModal onClose={() => setShowRules(false)} />}
      {showReview && <ReviewModal open={showReview} onClose={() => setShowReview(false)} />}
      {showSync && <SyncModal open={showSync} onClose={() => setShowSync(false)} />}
      {showShare && <ShareModal open={showShare} onClose={() => setShowShare(false)} />}
    </div>
  );
}