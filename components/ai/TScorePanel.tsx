'use client';

/**
 * 波段评分结果面板
 * 买点/卖点双信号分(0-100) + 因子分解 + LLM 微调与综合说明 + 分时上下文 + 触发规则。
 * 买卖点均恒算恒显（仓位未填不代表未持仓）。全篇"信号参考，非操作指令"。
 */

import type { RuleCheckResult } from '@/types';
import type { IntradayContext } from '@/services/t-score/intraday';
import type { TFactorScore } from '@/services/t-score/scorer';
import { SELL_RULE_IDS } from '@/services/alertRules';
import { cn } from '@/lib/utils';
import { Activity, AlertTriangle, Loader2 } from 'lucide-react';

export interface TScorePanelResult {
  degraded: boolean;
  degradation: string[];
  buyScore: number;
  sellScore: number;
  buyFactors: TFactorScore[];
  sellFactors: TFactorScore[];
  intraday: IntradayContext;
  engineResults: RuleCheckResult[];
  finalBuy: number;
  finalSell: number;
  buyAdjust: number;
  sellAdjust: number;
  buyReason: string;
  sellReason: string;
  analysis: string;
  confidence: number;
  tags: string[];
  llmAdjusted: boolean;
  coverage: number | null;
}

interface Props {
  result: TScorePanelResult;
  isRunning: boolean;
}

function scoreColor(score: number, kind: 'buy' | 'sell'): string {
  // 买点：高=强买信号=绿；卖点：高=强卖信号=红
  if (kind === 'buy') {
    if (score >= 70) return 'bg-green-500';
    if (score >= 40) return 'bg-amber-500';
    return 'bg-gray-400';
  }
  if (score >= 70) return 'bg-red-500';
  if (score >= 40) return 'bg-amber-500';
  return 'bg-gray-400';
}

function Gauge({ label, score, adjust, kind }: { label: string; score: number; adjust?: number | null; kind: 'buy' | 'sell' }) {
  return (
    <div className="flex-1 rounded-xl p-4 bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-800">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-gray-500">{label}</span>
        {adjust != null && adjust !== 0 && (
          <span className={cn('text-xs px-1.5 py-0.5 rounded', adjust > 0 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700')}>
            LLM {adjust > 0 ? '+' : ''}{adjust}
          </span>
        )}
      </div>
      <div className="flex items-end gap-2 mb-2">
        <span className="text-3xl font-bold text-gray-900 dark:text-white">{score}</span>
        <span className="text-sm text-gray-400 mb-1">/100</span>
      </div>
      <div className="h-2.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
        <div className={cn('h-full rounded-full transition-all', scoreColor(score, kind))} style={{ width: `${score}%` }} />
      </div>
    </div>
  );
}

function FactorTable({ factors }: { factors: TFactorScore[] }) {
  if (!factors || factors.length === 0) return null;
  return (
    <div className="space-y-1.5">
      {factors.map((f) => (
        <div key={f.name} className="flex items-center gap-2 text-xs">
          <span className="w-20 shrink-0 text-gray-500 dark:text-gray-400">{f.name}</span>
          <div className="flex-1 h-1.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
            <div className="h-full bg-purple-400 rounded-full" style={{ width: `${f.score}%` }} />
          </div>
          <span className="w-10 shrink-0 text-right text-gray-600 dark:text-gray-300 font-medium tabular-nums whitespace-nowrap">{f.score.toFixed(1)}</span>
          <span className="w-10 shrink-0 text-right text-gray-400 tabular-nums whitespace-nowrap">{(f.weight * 100).toFixed(0)}%</span>
        </div>
      ))}
    </div>
  );
}

export function TScorePanel({ result, isRunning }: Props) {
  if (result.degraded) {
    return (
      <div className="rounded-xl p-5 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 mb-4">
        <div className="flex items-center gap-2 text-amber-700 dark:text-amber-300 font-medium">
          <AlertTriangle className="w-5 h-5" />
          波段评分暂不可用
        </div>
        <p className="text-sm text-amber-600 dark:text-amber-400 mt-2">
          {result.degradation.includes('market_closed')
            ? '当前非交易时段，波段评分需在盘中（9:30-11:30 / 13:00-15:00）使用。'
            : '分时数据不足，暂无法计算盘中信号。'}
        </p>
        <p className="text-xs text-amber-500/70 mt-1">信号参考，非操作指令。</p>
      </div>
    );
  }

  const { intraday: ctx, engineResults } = result;
  const buyRules = engineResults.filter((r) => r.ruleId && !SELL_RULE_IDS.has(r.ruleId));
  const sellRules = engineResults.filter((r) => r.ruleId && SELL_RULE_IDS.has(r.ruleId));
  const llmPending = isRunning && !result.llmAdjusted && !result.analysis;

  return (
    <div className="space-y-3">
      {/* 双信号分 */}
      <div className="flex gap-3">
        <Gauge label="买点信号强度" score={result.finalBuy} adjust={result.buyAdjust} kind="buy" />
        <Gauge label="卖点信号强度" score={result.finalSell} adjust={result.sellAdjust} kind="sell" />
      </div>

      {/* 标签 */}
      {result.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {result.tags.map((t, i) => (
            <span key={i} className="px-2 py-0.5 rounded-full text-xs bg-purple-100 text-purple-700 dark:bg-purple-950/50 dark:text-purple-300">{t}</span>
          ))}
        </div>
      )}

      {/* LLM 综合说明 */}
      {result.analysis ? (
        <div className="rounded-xl p-4 bg-white dark:bg-gray-900 shadow-sm border-l-4 border-purple-500">
          <h3 className="font-semibold mb-1.5 text-purple-700 dark:text-purple-300 flex items-center gap-1.5">
            <Activity className="w-4 h-4" /> 综合说明
          </h3>
          <p className="text-sm text-gray-600 dark:text-gray-400 whitespace-pre-wrap leading-relaxed">{result.analysis}</p>
          {(result.buyReason || result.sellReason) && (
            <div className="mt-2 pt-2 border-t border-gray-100 dark:border-gray-800 text-xs text-gray-500 space-y-1">
              {result.buyReason && <p>买点：{result.buyReason}</p>}
              {result.sellReason && <p>卖点：{result.sellReason}</p>}
            </div>
          )}
        </div>
      ) : llmPending ? (
        <div className="rounded-xl p-4 bg-gray-50 dark:bg-gray-900/50 border border-gray-200 dark:border-gray-800 flex items-center gap-2 text-sm text-gray-400">
          <Loader2 className="w-4 h-4 animate-spin" /> 因子分已就绪，LLM 微调中...
        </div>
      ) : null}

      {/* 因子分解 */}
      <div className="rounded-xl p-4 bg-white dark:bg-gray-900 shadow-sm">
        <h3 className="font-semibold mb-3 text-sm">因子分解</h3>
        <FactorTable factors={result.buyFactors} />
        {result.sellFactors.length > 0 && (
          <>
            <div className="my-2 border-t border-gray-100 dark:border-gray-800" />
            <FactorTable factors={result.sellFactors} />
          </>
        )}
      </div>

      {/* 分时上下文 */}
      <div className="rounded-xl p-3 bg-white dark:bg-gray-900 shadow-sm text-xs text-gray-600 dark:text-gray-400">
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <span>现价 <b className="text-gray-800 dark:text-gray-200">{ctx.last.toFixed(2)}</b></span>
          <span>VWAP <b className="text-gray-800 dark:text-gray-200">{ctx.vwap.toFixed(2)}</b>（偏离 {ctx.vwapDevPct.toFixed(2)}%）</span>
          <span>日内 {ctx.low.toFixed(2)} - {ctx.high.toFixed(2)}</span>
          <span>位置 {ctx.rangePosPct.toFixed(0)}%</span>
          <span>动量 {ctx.mom15.toFixed(2)} bps/分</span>
          {ctx.granularity === 'm5' && <span className="text-amber-500">分时为5分K回退，低保真</span>}
        </div>
      </div>

      {/* 触发规则 */}
      {(buyRules.length > 0 || sellRules.length > 0) && (
        <div className="rounded-xl p-4 bg-white dark:bg-gray-900 shadow-sm">
          <h3 className="font-semibold mb-2 text-sm">预警引擎触发</h3>
          <div className="space-y-1 text-xs">
            {buyRules.map((r, i) => (
              <div key={`b${i}`} className="px-2 py-1 rounded bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-300">买·{r.message}</div>
            ))}
            {sellRules.map((r, i) => (
              <div key={`s${i}`} className="px-2 py-1 rounded bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300">卖·{r.message}</div>
            ))}
          </div>
        </div>
      )}

      <p className="text-xs text-gray-400 text-center">信号参考，非操作指令。</p>
    </div>
  );
}
