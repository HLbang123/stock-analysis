'use client';

/**
 * AI 筛选 tab — 扫描页内嵌，读 DB 展示每日调度结果（服务器 key 每日自动跑）。
 * 与旧 AiScreenPanel 的区别：无运行按钮/无进度条/无用户 key 依赖，打开即看当日结果。
 */

import { useState, useEffect, useCallback, Fragment } from 'react';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import { ChevronDown, ChevronUp, Info, Sparkles, AlertTriangle, Loader2 } from 'lucide-react';
import type { AiPick } from '@/services/ai-screen/types';

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
  picks: AiPick[];
}

export function AiScreenTab() {
  const router = useRouter();
  const [strategies, setStrategies] = useState<StrategyInfo[]>([]);
  const [selected, setSelected] = useState<string>('momentum');
  const [current, setCurrent] = useState<RunWithPicks | null>(null);
  const [loading, setLoading] = useState(false);
  const [showLlm, setShowLlm] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);

  // 拉策略定义 + 历史运行列表
  useEffect(() => {
    fetch('/api/ai-screen')
      .then((r) => r.json())
      .then((d) => {
        if (d.strategies) {
          const daily = d.strategies.filter((s: StrategyInfo) => s.id === 'momentum' || s.id === 'balanced');
          setStrategies(daily);
        }
      })
      .catch(() => {});
  }, []);

  // 拉选中策略最近一次运行（含 picks）
  const loadLatest = useCallback(async (strategyId: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/ai-screen/latest?strategyId=${strategyId}`);
      const d = await res.json();
      if (d.run) setCurrent(d.run);
      else setCurrent(null);
    } catch {
      setCurrent(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadLatest(selected);
  }, [selected, loadLatest]);

  const toAppCode = (tsCode: string) => {
    const m = tsCode.match(/^(\d+)\.(SH|SZ|BJ)$/);
    return m ? m[2].toLowerCase() + m[1] : tsCode;
  };

  const selectedStrategy = strategies.find((s) => s.id === selected);

  return (
    <div>
      {/* 策略大卡：名称 + 一句话，完整规则折叠在下方 */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        {strategies.map((s) => {
          const active = selected === s.id;
          return (
            <button
              key={s.id}
              onClick={() => { setSelected(s.id); setExpanded(null); }}
              className={cn(
                'relative p-4 rounded-xl text-left border-2 transition',
                active
                  ? 'border-purple-500 bg-purple-50 dark:bg-purple-950/40'
                  : 'border-gray-200 dark:border-gray-700 hover:border-gray-300',
              )}
            >
              <div className="font-semibold text-gray-900 dark:text-white">{s.name}</div>
            </button>
          );
        })}
      </div>

      {/* 策略说明（默认折叠）：当前选中策略的完整规则 */}
      {selectedStrategy && (
        <div className="mb-4">
          <button onClick={() => setShowRules(!showRules)} className="flex items-center gap-1 text-xs text-purple-600">
            <Info className="w-3.5 h-3.5" /> 策略说明
            {showRules ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
          {showRules && (
            <div className="mt-2 rounded-xl bg-purple-50/60 dark:bg-purple-950/20 border border-purple-100 dark:border-purple-900 p-3 text-xs text-gray-600 dark:text-gray-400 space-y-2">
              <p className="whitespace-pre-line leading-relaxed">{selectedStrategy.description}</p>
              {selectedStrategy.rulesText && <p className="whitespace-pre-line leading-relaxed opacity-90">{selectedStrategy.rulesText}</p>}
            </div>
          )}
        </div>
      )}

      {/* 运行概况 + AI 视角 */}
      {current && (
        <Card className="p-3 mb-4">
          <div className="flex flex-wrap items-center gap-3 text-xs text-gray-500">
            <span>数据日 {current.barDate}</span>
            <span>候选 {current.candidateCount} → 入选 {current.pickCount}</span>
            {current.llmReranked ? (
              <span className="bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">AI 重排{current.llmCoverage != null ? ` ${(current.llmCoverage * 100).toFixed(0)}%` : ''}</span>
            ) : (
              <span className="bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">纯规则</span>
            )}
          </div>
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
                  <th className="px-3 py-2 w-10 whitespace-nowrap">#</th>
                  <th className="px-3 py-2 whitespace-nowrap">标的</th>
                  <th className="px-3 py-2 text-right whitespace-nowrap">综合分</th>
                  <th className="px-3 py-2 text-right whitespace-nowrap">规则/LLM</th>
                  <th className="px-3 py-2 text-right whitespace-nowrap">涨跌</th>
                  <th className="px-3 py-2 min-w-[220px] whitespace-nowrap">理由 / 风险</th>
                </tr>
              </thead>
              <tbody>
                {current.picks.map((k, i) => (
                  <Fragment key={k.tsCode}>
                    <tr
                      onClick={() => setExpanded(expanded === i ? null : i)}
                      className={cn(
                        'border-b border-gray-50 dark:border-gray-800/50 hover:bg-gray-50 dark:hover:bg-gray-800/30 transition cursor-pointer',
                        k.riskLevel === 'high' ? 'bg-red-50/30 dark:bg-red-950/10' : '',
                      )}
                    >
                      <td className="px-3 py-2.5 text-gray-400">{k.rank}</td>
                      <td className="px-3 py-2.5" onClick={(e) => { e.stopPropagation(); router.push(`/stock/${toAppCode(k.tsCode)}`); }}>
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
                        <td colSpan={6} className="px-4 py-3 text-xs space-y-2">
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
