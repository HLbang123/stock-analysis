'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card } from '@/components/ui/card';
import { Activity, Loader2 } from 'lucide-react';
import { pct, signed, toneCls, Metric, StatsEmpty } from './stats-primitives';
import { cn } from '@/lib/utils';

interface ShortTermStatsData {
  primaryN: number;
  summary: { count: number; winRate: number | null; avg: number | null; median: number | null };
  strategies: {
    strategyId: string;
    strategyName: string;
    evaluatedCount: number;
    avgReturn: number | null;
    winRate: number | null;
    byHoldingPeriod: Record<number, { count: number; winRate: number | null; avg: number | null; median: number | null }>;
  }[];
}

const weak = (count: number, min = 5) => count < min;
const weakCls = (count: number, min = 5) => (weak(count, min) ? 'text-gray-400 dark:text-gray-500' : '');

export function ShortTermStats() {
  const [stats, setStats] = useState<ShortTermStatsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch('/api/short-term-strategies/stats');
      if (!res.ok) throw new Error();
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setStats(data);
    } catch {
      setStats(null);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading && !stats) {
    return (
      <div className="text-center py-12 text-gray-400">
        <Loader2 className="w-8 h-8 mx-auto mb-3 animate-spin" />
        <p className="text-sm">读取中…</p>
      </div>
    );
  }

  if (error && !stats) {
    return (
      <div className="text-center py-10">
        <p className="text-sm text-[var(--color-danger)] mb-2">超短线复盘加载失败</p>
        <button onClick={load} className="text-xs text-[var(--color-accent)] hover:underline">重试</button>
      </div>
    );
  }

  if (!stats) return <StatsEmpty>暂无回测数据</StatsEmpty>;

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
          <Metric label={`T+${stats.primaryN} 胜率`} value={stats.summary.winRate == null ? '--' : `${stats.summary.winRate}%`} />
          <Metric label={`T+${stats.primaryN} 均值`} value={signed(stats.summary.avg)} tone={stats.summary.avg != null ? (stats.summary.avg >= 0 ? 'up' : 'down') : undefined} />
          <Metric label={`T+${stats.primaryN} 中位数`} value={signed(stats.summary.median)} tone={stats.summary.median != null ? (stats.summary.median >= 0 ? 'up' : 'down') : undefined} />
          <Metric label="回填样本" value={`${stats.summary.count}`} />
        </div>
      </Card>

      <Card className="p-4">
        <div className="text-sm font-medium mb-2 flex items-center gap-1"><Activity className="w-4 h-4" /> 策略胜率</div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-100 dark:border-gray-800 text-left text-gray-400">
                <th className="px-2 py-1.5">策略</th>
                <th className="px-2 py-1.5 text-right">样本</th>
                <th className="px-2 py-1.5 text-right">T+1胜率</th>
                <th className="px-2 py-1.5 text-right">T+5胜率</th>
                <th className="px-2 py-1.5 text-right">T+20胜率</th>
                <th className="px-2 py-1.5 text-right">T+5均值</th>
                <th className="px-2 py-1.5 text-right">T+5中位</th>
              </tr>
            </thead>
            <tbody>
              {stats.strategies.map((s) => (
                <tr key={s.strategyId} className="border-b border-gray-50 dark:border-gray-800/50">
                  <td className="px-2 py-1.5 font-medium">{s.strategyName}</td>
                  <td className="px-2 py-1.5 text-right text-gray-500">{s.evaluatedCount}</td>
                  <td className={cn('px-2 py-1.5 text-right', weakCls(s.byHoldingPeriod?.[1]?.count ?? 0))}>{pct(s.byHoldingPeriod?.[1]?.winRate, 0)}%</td>
                  <td className={cn('px-2 py-1.5 text-right font-semibold', weakCls(s.byHoldingPeriod?.[5]?.count ?? 0))}>{pct(s.byHoldingPeriod?.[5]?.winRate, 0)}%</td>
                  <td className={cn('px-2 py-1.5 text-right', weakCls(s.byHoldingPeriod?.[20]?.count ?? 0))}>{pct(s.byHoldingPeriod?.[20]?.winRate, 0)}%</td>
                  <td className={cn('px-2 py-1.5 text-right font-mono', toneCls(s.byHoldingPeriod?.[5]?.avg))}>{signed(s.byHoldingPeriod?.[5]?.avg)}</td>
                  <td className={cn('px-2 py-1.5 text-right font-mono', toneCls(s.byHoldingPeriod?.[5]?.median))}>{signed(s.byHoldingPeriod?.[5]?.median)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}