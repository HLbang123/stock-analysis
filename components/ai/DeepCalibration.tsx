'use client';

/**
 * 深度分析历史校准（P0/P1）— 把 DeepAnalysisRecord/Eval 回测数据带到决策时刻：
 *  - VerdictCalibrationNote：新裁决卡片内一行「同类建议历史胜率」，胜率偏低出警示（P0）
 *  - StockTrackStrip：选中标的即显示「本票历史战绩条」（P1）
 * 数据源：/api/ai/deep-eval/stats（全局，模块级缓存）+ /api/ai/deep-eval?stockCode=（个股）
 */

import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';

interface ActionStat { action: string; count: number; winRate: number | null; avgReturn: number | null }
interface BucketStat { bucket: string; count: number; winRate: number | null; avgReturn: number | null }
interface DeepStats {
  summary: { byAction: ActionStat[] };
  confidenceBuckets: BucketStat[];
}

interface StockEval { nDays: number; returnPct: number | null }
interface StockRecord { id: string; entryDate: string; action: string; confidence: number | null; evals: StockEval[] }

// ── 全局 stats：模块级缓存 + 在途去重（一次会话只拉一次）──────────────
let statsCache: DeepStats | null = null;
let statsPromise: Promise<DeepStats | null> | null = null;
function loadStats(): Promise<DeepStats | null> {
  if (statsCache) return Promise.resolve(statsCache);
  if (!statsPromise) {
    statsPromise = fetch('/api/ai/deep-eval/stats')
      .then((r) => r.json())
      .then((d) => { statsCache = d?.error ? null : d; return statsCache; })
      .catch(() => null);
  }
  return statsPromise;
}

/** 与服务端 isWin 同口径：买入看涨、卖出看跌、持有看震荡 */
const isWin = (action: string, returnPct: number) =>
  action === '买入' ? returnPct > 0 : action === '卖出' ? returnPct < 0 : Math.abs(returnPct) < 5;

/** 置信度分桶（与 stats 路由 bucketize 口径一致：≤30 低 / 31-70 中 / ≥71 高） */
const confBucketLabel = (v: number) => (v <= 30 ? '低(≤30)' : v <= 70 ? '中(31-70)' : '高(≥71)');

export interface CalibrationData {
  loaded: boolean;
  actionStat: ActionStat | null;    // 同类方向全局 T+5
  confStat: BucketStat | null;      // 同置信度档全局 T+5
  stockTotal: number;               // 本票分析总次数
  stockByAction: { action: string; count: number; winRate: number | null }[];
  stockRecent: StockRecord[];       // 本票最近记录（含 T+N 结果）
}

export function useDeepCalibration(stockCode?: string, action?: string, confidence?: number): CalibrationData {
  const [stats, setStats] = useState<DeepStats | null>(statsCache);
  const [records, setRecords] = useState<StockRecord[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    loadStats().then((s) => { if (alive) { setStats(s); setLoaded(true); } });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!stockCode) { setRecords([]); return; }
    let alive = true;
    fetch(`/api/ai/deep-eval?stockCode=${stockCode}`)
      .then((r) => r.json())
      .then((d) => { if (alive) setRecords(d?.records ?? []); })
      .catch(() => { if (alive) setRecords([]); });
    return () => { alive = false; };
  }, [stockCode]);

  const actionStat = action ? stats?.summary.byAction.find((a) => a.action === action) ?? null : null;
  const confStat = confidence != null && stats
    ? stats.confidenceBuckets.find((b) => b.bucket === confBucketLabel(confidence)) ?? null
    : null;

  // 本票分方向聚合（T+5 口径）
  const stockByActionMap = new Map<string, { count: number; wins: number; evaluated: number }>();
  let stockTotal = records.length;
  for (const r of records) {
    const g = stockByActionMap.get(r.action) ?? { count: 0, wins: 0, evaluated: 0 };
    g.count++;
    const e5 = r.evals.find((e) => e.nDays === 5 && e.returnPct != null);
    if (e5) {
      g.evaluated++;
      if (isWin(r.action, e5.returnPct!)) g.wins++;
    }
    stockByActionMap.set(r.action, g);
  }
  const stockByAction = Array.from(stockByActionMap.entries()).map(([a, g]) => ({
    action: a,
    count: g.count,
    winRate: g.evaluated > 0 ? Math.round((g.wins / g.evaluated) * 1000) / 10 : null,
  }));

  return { loaded, actionStat, confStat, stockTotal, stockByAction, stockRecent: records.slice(0, 5) };
}

// ── P0：裁决卡片内的历史校准一行 ────────────────────────────────────
export function VerdictCalibrationNote({ stockCode, action, confidence }: { stockCode?: string; action?: string; confidence?: number }) {
  const cal = useDeepCalibration(stockCode, action, confidence);
  if (!cal.loaded || (!cal.actionStat && !cal.confStat && cal.stockTotal === 0)) return null;

  const lowWin = cal.actionStat && cal.actionStat.count >= 8 && cal.actionStat.winRate != null && cal.actionStat.winRate < 45;
  const stockSame = action ? cal.stockByAction.find((a) => a.action === action) : null;

  return (
    <div className="mt-3 pt-3 border-t border-gray-200/60 dark:border-gray-700/60">
      <p className="text-xs text-gray-500 dark:text-gray-400 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium text-gray-600 dark:text-gray-300">📈 历史校准</span>
        {cal.actionStat && cal.actionStat.winRate != null && (
          <span>同类「{action}」T+5 胜率 <b className="text-gray-700 dark:text-gray-200">{cal.actionStat.winRate}%</b>（{cal.actionStat.count} 次）</span>
        )}
        {cal.confStat && cal.confStat.winRate != null && (
          <span>· {cal.confStat.bucket.split('(')[0]}信心档 <b className="text-gray-700 dark:text-gray-200">{cal.confStat.winRate}%</b>（{cal.confStat.count} 次）</span>
        )}
        {stockSame && stockSame.winRate != null && (
          <span>· 本票{stockSame.count} 次「{action}」胜率 <b className="text-gray-700 dark:text-gray-200">{stockSame.winRate}%</b></span>
        )}
        {lowWin && (
          <span className="px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-[var(--color-warning-soft)] text-[var(--color-warning)] font-medium">
            该方向历史胜率偏低，谨慎参考
          </span>
        )}
      </p>
    </div>
  );
}

// ── P1：选中标的的历史战绩条 ────────────────────────────────────────
export function StockTrackStrip({ stockCode }: { stockCode?: string }) {
  const cal = useDeepCalibration(stockCode);
  if (!cal.loaded || cal.stockTotal === 0) return null;

  const ACTION_CLS: Record<string, string> = {
    '买入': 'text-[var(--color-up)]',
    '卖出': 'text-[var(--color-down)]',
    '持有': 'text-gray-500',
  };
  const recent = cal.stockRecent[0];
  const recentE5 = recent?.evals.find((e) => e.nDays === 5 && e.returnPct != null);

  return (
    <div className="mb-1 px-2.5 py-2 rounded-[var(--radius-md)] bg-[var(--color-accent-soft)]/60 dark:bg-gray-800/60 text-xs flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="font-medium text-gray-600 dark:text-gray-300">本票历史</span>
      <span className="text-gray-500">分析 {cal.stockTotal} 次</span>
      {cal.stockByAction.map((a) => (
        <span key={a.action} className={cn('whitespace-nowrap', ACTION_CLS[a.action] ?? 'text-gray-500')}>
          {a.action}×{a.count}{a.winRate != null ? ` 胜率${a.winRate}%` : ''}
        </span>
      ))}
      {recent && (
        <span className="text-gray-400 ml-auto whitespace-nowrap">
          最近 {recent.entryDate.slice(4, 6)}-{recent.entryDate.slice(6, 8)} {recent.action}
          {recentE5 && (
            <b className={recentE5.returnPct! >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}>
              {' '}T+5 {recentE5.returnPct! >= 0 ? '+' : ''}{recentE5.returnPct!.toFixed(1)}%
            </b>
          )}
        </span>
      )}
    </div>
  );
}
