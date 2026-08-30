'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card } from '@/components/ui/card';
import { Activity, Loader2, Calendar } from 'lucide-react';
import { pct, signed, toneCls, Metric, StatsEmpty } from './stats-primitives';
import { cn } from '@/lib/utils';

interface ExitStat { count: number; winRate: number | null; avg: number | null; median: number | null; }

interface HistoryItem {
  id: string;
  strategy: string;
  strategyName: string;
  name: string;
  tsCode: string;
  matchedDate: string;
  signalType: string;
  t1: Record<string, number>;
}

interface ShortTermHistoryData {
  dates: string[];
  byDate: Record<string, HistoryItem[]>;
}

interface ShortTermStatsData {
  primaryExit: string;
  summary: { count: number; winRate: number | null; avg: number | null; median: number | null };
  strategies: {
    strategyId: string;
    strategyName: string;
    evaluatedCount: number;
    avgReturn: number | null;
    winRate: number | null;
    byExit: Record<string, ExitStat>;
  }[];
}

const weak = (count: number, min = 5) => count < min;
const weakCls = (count: number, min = 5) => (weak(count, min) ? 'text-gray-400 dark:text-gray-500' : '');

export function ShortTermStats() {
  const [stats, setStats] = useState<ShortTermStatsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [history, setHistory] = useState<ShortTermHistoryData | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

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

  useEffect(() => {
    fetch('/api/short-term-strategies/history')
      .then((r) => r.json())
      .then((d: ShortTermHistoryData) => {
        if (d && d.dates?.length) {
          setHistory(d);
          setSelectedDate((prev) => prev ?? d.dates[0]);
        }
      })
      .catch(() => {});
  }, []);

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
          <Metric label="T+1 最高胜率" value={stats.summary.winRate == null ? '--' : `${stats.summary.winRate}%`} />
          <Metric label="T+1 最高均值" value={signed(stats.summary.avg)} tone={stats.summary.avg != null ? (stats.summary.avg >= 0 ? 'up' : 'down') : undefined} />
          <Metric label="T+1 最高中位数" value={signed(stats.summary.median)} tone={stats.summary.median != null ? (stats.summary.median >= 0 ? 'up' : 'down') : undefined} />
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
                <th className="px-2 py-1.5 text-right">开盘胜率</th>
                <th className="px-2 py-1.5 text-right">最高胜率</th>
                <th className="px-2 py-1.5 text-right">收盘胜率</th>
                <th className="px-2 py-1.5 text-right">最高均值</th>
                <th className="px-2 py-1.5 text-right">最高中位</th>
              </tr>
            </thead>
            <tbody>
              {stats.strategies.map((s) => {
                const o = s.byExit?.open;
                const h = s.byExit?.high;
                const c = s.byExit?.close;
                return (
                  <tr key={s.strategyId} className="border-b border-gray-50 dark:border-gray-800/50">
                    <td className="px-2 py-1.5 font-medium">{s.strategyName}</td>
                    <td className="px-2 py-1.5 text-right text-gray-500">{s.evaluatedCount}</td>
                    <td className={cn('px-2 py-1.5 text-right', weakCls(o?.count ?? 0))}>{pct(o?.winRate, 0)}%</td>
                    <td className={cn('px-2 py-1.5 text-right font-semibold', weakCls(h?.count ?? 0))}>{pct(h?.winRate, 0)}%</td>
                    <td className={cn('px-2 py-1.5 text-right', weakCls(c?.count ?? 0))}>{pct(c?.winRate, 0)}%</td>
                    <td className={cn('px-2 py-1.5 text-right font-mono', toneCls(h?.avg))}>{signed(h?.avg)}</td>
                    <td className={cn('px-2 py-1.5 text-right font-mono', toneCls(h?.median))}>{signed(h?.median)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm font-medium flex items-center gap-1"><Calendar className="w-4 h-4" /> 历史明细（次日四涨幅）</div>
          {history?.dates?.length ? (
            <select value={selectedDate ?? ''} onChange={(e) => setSelectedDate(e.target.value)} className="text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1 bg-white dark:bg-gray-900">
              {history.dates.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          ) : null}
        </div>
        {selectedDate && history?.byDate?.[selectedDate]?.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-800 text-left text-gray-400">
                  <th className="px-2 py-1.5">标的</th>
                  <th className="px-2 py-1.5">策略</th>
                  <th className="px-2 py-1.5 text-right">开盘</th>
                  <th className="px-2 py-1.5 text-right">最高</th>
                  <th className="px-2 py-1.5 text-right">最低</th>
                  <th className="px-2 py-1.5 text-right">收盘</th>
                </tr>
              </thead>
              <tbody>
                {history.byDate[selectedDate].map((it) => (
                  <tr key={it.id} className="border-b border-gray-50 dark:border-gray-800/50">
                    <td className="px-2 py-1.5 font-medium">{it.name} <span className="text-gray-400">{it.tsCode}</span></td>
                    <td className="px-2 py-1.5 text-gray-500">{it.strategyName}</td>
                    <td className={cn('px-2 py-1.5 text-right font-mono', toneCls(it.t1.open ?? null))}>{signed(it.t1.open ?? null)}</td>
                    <td className={cn('px-2 py-1.5 text-right font-mono', toneCls(it.t1.high ?? null))}>{signed(it.t1.high ?? null)}</td>
                    <td className={cn('px-2 py-1.5 text-right font-mono', toneCls(it.t1.low ?? null))}>{signed(it.t1.low ?? null)}</td>
                    <td className={cn('px-2 py-1.5 text-right font-mono', toneCls(it.t1.close ?? null))}>{signed(it.t1.close ?? null)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-xs text-gray-400 py-3 text-center">暂无历史明细</div>
        )}
      </Card>
    </div>
  );
}