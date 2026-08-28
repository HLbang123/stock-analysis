'use client';

import { useState, useEffect, Fragment } from 'react';
import { useRouter } from 'next/navigation';
import { useUiStore } from '@/store/ui-store';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import { ChevronDown, ChevronUp, Info, Sparkles, AlertTriangle, Loader2 } from 'lucide-react';
import type { AiPick } from '@/services/ai-screen/types';
import { ShortTermTab } from '@/components/ShortTermTab';
import { getClientTier } from '@/lib/client-auth';

/**
 * AI 筛选 tab — 扫描页内嵌，读 DB 展示每日调度结果（服务器每日自动跑）。
 * 两个主 tab：超短线（涨停+三连阴 / 龙首阴 / 双龙战法）、短线（趋势，复用原趋势猎手逻辑改名）。
 */

interface StrategyInfo {
  id: string;
  name: string;
  description: string;
  category: string;
  rulesText: string;
}

interface RunWithPicks {
  id: string;
  strategyId: string;
  strategyName: string;
  createdAt: string;
  barDate: string;
  candidateCount: number;
  pickCount: number;
  llmReranked: boolean;
  llmModel?: string | null;
  llmCoverage?: number | null;
  llmMarketView?: string;
  llmSelectionLogic?: string;
  llmPortfolioRisk?: string;
  degradation: string[];
  marketRegime?: string | null; // attack/neutral/defense
  picks: AiPick[];
}

const MAIN_TABS = [
  { value: 'ultra-short', label: '超短线' },
  { value: 'short', label: '趋势优选' },
] as const;

export function AiScreenTab() {
  const mainTab = useUiStore((s) => s.aiScreenMainTab);
  const setMainTab = useUiStore((s) => s.setAiScreenMainTab);
  const [tier, setTier] = useState<'basic' | 'advanced'>('basic');

  useEffect(() => {
    setTier(getClientTier());
  }, []);

  const ultraShortEnabled = tier === 'advanced';
  const visibleTabs = ultraShortEnabled ? MAIN_TABS : MAIN_TABS.filter((t) => t.value !== 'ultra-short');
  const effectiveMainTab = mainTab === 'ultra-short' && !ultraShortEnabled ? 'short' : mainTab;

  return (
    <div>
      {/* 两个主 tab：专用口令显示超短线（三套短线策略）；普通口令只显示短线（趋势） */}
      <div className="flex gap-1 mb-4 p-1 bg-gray-100 dark:bg-gray-800 rounded-lg w-fit">
        {visibleTabs.map((t) => (
          <button
            key={t.value}
            onClick={() => setMainTab(t.value)}
            className={cn(
              'px-4 py-1.5 rounded-md text-sm transition',
              effectiveMainTab === t.value
                ? 'bg-white dark:bg-gray-900 shadow-sm font-medium text-gray-900 dark:text-white'
                : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-200',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {effectiveMainTab === 'ultra-short' ? <ShortTermTab /> : <ShortLineTab />}
    </div>
  );
}

function ShortLineTab() {
  const router = useRouter();
  const [strategy, setStrategy] = useState<StrategyInfo | null>(null);
  const [current, setCurrent] = useState<RunWithPicks | null>(null);
  const [loading, setLoading] = useState(true);
  const [showLlm, setShowLlm] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  // 表头排序：null=按 AI 排名（rank）展示
  const [sortKey, setSortKey] = useState<'final' | 'screen' | 'change' | null>(null);
  const [sortDir, setSortDir] = useState<-1 | 1>(-1);

  const toggleSort = (k: 'final' | 'screen' | 'change') => {
    if (sortKey === k) setSortDir((d) => (d === -1 ? 1 : -1));
    else { setSortKey(k); setSortDir(-1); }
  };
  const sortMark = (k: string) => (sortKey === k ? (sortDir === -1 ? ' ↓' : ' ↑') : '');
  const sortedPicks = (picks: AiPick[]) => {
    if (!sortKey) return picks;
    const val = (k: AiPick): number | null =>
      sortKey === 'final' ? k.finalScore : sortKey === 'screen' ? k.screenScore : k.latestChange;
    return [...picks].sort((a, b) => {
      const va = val(a), vb = val(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return (va - vb) * sortDir;
    });
  };

  // 拉策略定义（短线 tab 复用原 momentum「趋势猎手」逻辑，改名「趋势」）+ 最近一次运行
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch('/api/ai-screen').then((r) => r.json()),
      fetch('/api/ai-screen/latest?strategyId=momentum').then((r) => r.json()),
    ])
      .then(([stratD, latestD]) => {
        if (cancelled) return;
        if (stratD.strategies) {
          const m = stratD.strategies.find((s: StrategyInfo) => s.id === 'momentum');
          if (m) setStrategy(m);
        }
        if (latestD.run) setCurrent(latestD.run);
        else setCurrent(null);
      })
      .catch(() => {
        if (!cancelled) setCurrent(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toAppCode = (tsCode: string) => {
    const m = tsCode.match(/^(\d+)\.(SH|SZ|BJ)$/);
    return m ? m[2].toLowerCase() + m[1] : tsCode;
  };

  return (
    <div>
      {/* 短线策略头 + 说明（折叠） */}
      <div className="mb-4">
        <p className="text-xs text-gray-400">强势低波入场，不追成熟多头</p>
        <button onClick={() => setShowRules(!showRules)} className="flex items-center gap-1 text-xs text-purple-600 mt-1">
          <Info className="w-3.5 h-3.5" /> 策略说明
          {showRules ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </button>
        {showRules && strategy && (
          <div className="mt-2 rounded-xl bg-purple-50/60 dark:bg-purple-950/20 border border-purple-100 dark:border-purple-900 p-3 text-xs text-gray-600 dark:text-gray-400 space-y-2">
            <p className="whitespace-pre-line leading-relaxed">{strategy.description}</p>
            {strategy.rulesText && <p className="whitespace-pre-line leading-relaxed opacity-90">{strategy.rulesText}</p>}
          </div>
        )}
      </div>

      {/* 运行概况 + AI 视角 */}
      {current && (
        <Card className="p-3 mb-4">
          <div className="flex flex-wrap items-center gap-3 text-xs text-gray-500">
            <span>数据日 {current.barDate}</span>
            {current.marketRegime && current.marketRegime !== 'neutral' && (
              <span className={cn('px-1.5 py-0.5 rounded',
                current.marketRegime === 'attack'
                  ? 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400'
                  : 'bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-400')}>
                {current.marketRegime === 'attack' ? '活跃' : current.marketRegime === 'defense' ? '收缩' : '震荡'}
              </span>
            )}
            <span>候选 {current.candidateCount} → 入选 {current.pickCount}</span>
            {current.llmReranked ? (
              <span className="bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">AI 重排{current.llmCoverage != null ? ` ${(current.llmCoverage * 100).toFixed(0)}%` : ''}</span>
            ) : (
              <span className="bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">纯规则</span>
            )}
          </div>
          {current.marketRegime === 'defense' && (
            <div className="text-xs text-amber-600 flex items-start gap-1 mt-2">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>防守期趋势型策略历史偏弱，参考即可</span>
            </div>
          )}
          {!current.llmReranked && current.degradation.length > 0 && (
            <div className="text-xs text-amber-600 flex items-start gap-1 mt-2">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>降级：{current.degradation.slice(0, 3).join('；')}{current.degradation.length > 3 ? '…' : ''}</span>
            </div>
          )}
          {current.llmReranked && (current.llmMarketView || current.llmSelectionLogic) && (
            <button onClick={() => setShowLlm(!showLlm)} className="flex items-center gap-1 text-xs text-purple-600 mt-2">
              <Sparkles className="w-3.5 h-3.5" /> AI 视角
              {showLlm ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </button>
          )}
          {showLlm && (
            <div className="mt-2 text-xs text-gray-600 dark:text-gray-400 space-y-1.5">
              {current.llmMarketView && <p><strong>市场视角：</strong>{current.llmMarketView}</p>}
              {current.llmSelectionLogic && <p><strong>排序逻辑：</strong>{current.llmSelectionLogic}</p>}
              {current.llmPortfolioRisk && <p><strong>组合风险：</strong>{current.llmPortfolioRisk}</p>}
            </div>
          )}
        </Card>
      )}

      {/* 结果 */}
      {loading ? (
        <div className="text-center py-16 text-gray-400">
          <Loader2 className="w-8 h-8 mx-auto mb-3 animate-spin" />
          <p className="text-sm">读取中…</p>
        </div>
      ) : current && current.picks.length > 0 ? (
        <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-800 text-left text-xs text-gray-400 uppercase">
                  <th className="px-3 py-2 whitespace-nowrap">标的</th>
                  <th className="px-3 py-2 text-right whitespace-nowrap cursor-pointer select-none hover:text-gray-600 dark:hover:text-gray-200" onClick={() => toggleSort('final')}>综合分{sortMark('final')}</th>
                  <th className="px-3 py-2 text-right whitespace-nowrap cursor-pointer select-none hover:text-gray-600 dark:hover:text-gray-200" onClick={() => toggleSort('screen')}>规则/LLM{sortMark('screen')}</th>
                  <th className="px-3 py-2 text-right whitespace-nowrap cursor-pointer select-none hover:text-gray-600 dark:hover:text-gray-200" onClick={() => toggleSort('change')}>涨跌{sortMark('change')}</th>
                  <th className="px-3 py-2 min-w-[220px] whitespace-nowrap">理由 / 风险</th>
                </tr>
              </thead>
              <tbody>
                {sortedPicks(current.picks).map((k, i) => (
                  <Fragment key={k.tsCode}>
                    <tr
                      onClick={() => setExpanded(expanded === i ? null : i)}
                      className={cn(
                        'border-b border-gray-50 dark:border-gray-800/50 hover:bg-gray-50 dark:hover:bg-gray-800/30 transition cursor-pointer',
                        k.riskLevel === 'high' ? 'bg-red-50/30 dark:bg-red-950/10' : '',
                      )}
                    >
                      <td className="px-3 py-2.5 whitespace-nowrap" onClick={(e) => { e.stopPropagation(); router.push(`/stock/${toAppCode(k.tsCode)}`); }}>
                        <div className="font-medium text-blue-600 hover:underline">{k.name}</div>
                        <div className="text-gray-400 text-xs">{k.tsCode.replace(/\.(SH|SZ|BJ)$/, '')} · {k.industry || '--'}</div>
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono font-semibold">{k.finalScore.toFixed(1)}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-xs text-gray-500">
                        {k.screenScore.toFixed(0)}{k.llmScore != null ? `/${k.llmScore.toFixed(0)}` : ''}
                      </td>
                      <td className={cn('px-3 py-2.5 text-right font-mono', (k.latestChange ?? 0) >= 0 ? 'text-red-600' : 'text-green-600')}>
                        {k.latestChange != null ? `${k.latestChange >= 0 ? '+' : ''}${k.latestChange.toFixed(2)}%` : '--'}
                      </td>
                      <td className="px-3 py-2.5 text-xs">
                        <div className="text-gray-700 dark:text-gray-300 break-words">{k.rankingReason || k.llmThesis || (k.llmScore == null ? 'AI 未覆盖（规则分排序）' : '--')}</div>
                        <div className="flex gap-1 mt-1 flex-wrap">
                          {k.riskLevel !== 'low' && <span className={cn('px-1 py-0.5 rounded', k.riskLevel === 'high' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700')}>风险{k.riskLevel === 'high' ? '高' : '中'}</span>}
                          {k.llmTags.slice(0, 2).map((t) => (
                            <span key={t} className="px-1 py-0.5 rounded bg-gray-100 text-gray-600">{t}</span>
                          ))}
                        </div>
                      </td>
                    </tr>
                    {expanded === i && (
                      <tr className="bg-gray-50/50 dark:bg-gray-800/20">
                        <td colSpan={5} className="px-4 py-3 text-xs space-y-2">
                          {k.llmThesis && <p><strong>核心假设：</strong>{k.llmThesis}</p>}
                          {k.riskSummary && <p><strong>主要风险：</strong>{k.riskSummary}</p>}
                          {k.llmCatalysts.length > 0 && <p className="text-green-600">催化：{k.llmCatalysts.join('、')}</p>}
                          {k.llmWatchItems.length > 0 && <p className="text-gray-500">跟踪：{k.llmWatchItems.join('；')}</p>}
                          {k.llmInvalidators.length > 0 && <p className="text-red-500">证伪点：{k.llmInvalidators.join('；')}</p>}
                          <div className="flex flex-wrap gap-2 pt-1">
                            {Object.entries(k.factorScores).map(([fk, fv]) => (
                              <span key={fk} className="text-gray-500">{fk}:{fv.toFixed(0)}</span>
                            ))}
                          </div>
                          <div className="flex flex-wrap gap-3 text-gray-500 pt-1">
                            <span>RPS {k.rps?.toFixed(1) ?? '--'}</span>
                            <span>60日 {k.ret60d?.toFixed(1) ?? '--'}%</span>
                            <span>波动 {k.volatility20d?.toFixed(1) ?? '--'}%</span>
                            <span>回撤 {k.maxDrawdown20d?.toFixed(1) ?? '--'}%</span>
                            <span>量比 {k.volumeRatio?.toFixed(1) ?? '--'}</span>
                            <span>ROE {k.roe?.toFixed(1) ?? '--'}%</span>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : current ? (
        <div className="text-center py-16 text-gray-400">
          <Sparkles className="w-16 h-16 mx-auto mb-4 opacity-20" />
          <p className="text-lg">今日无标的过门槛</p>
          <p className="text-sm mt-2">规则分未达门槛</p>
        </div>
      ) : (
        <div className="text-center py-16 text-gray-400">
          <Sparkles className="w-16 h-16 mx-auto mb-4 opacity-20" />
          <p className="text-lg">今日筛选尚未生成</p>
          <p className="text-sm mt-2">每日 18:30 后自动运行，稍后打开查看</p>
        </div>
      )}
    </div>
  );
}
