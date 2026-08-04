'use client';

/**
 * 深度分析胜率复盘面板 — 调 /api/ai/deep-eval/stats 展示:
 * 整体指标卡 / 建议方向(买入·持有·卖出)×T+N 胜率榜 / 买入目标·止损命中 / 置信度·仓位校准
 * 主口径 T+5 绝对收益(买入看涨·卖出看跌·持有看震荡)，与 AI 筛选胜率复盘同口径。
 */

import { useState, useEffect, useCallback } from 'react';
import { Card } from '@/components/ui/card';
import { Activity, Target } from 'lucide-react';
import { cn } from '@/lib/utils';
import { pct, signed, Metric, StatsHeader, StatsEmpty } from './stats-primitives';

interface Stats {
  summary: {
    primaryN: number;
    totalRecords: number;
    totalEvals: number;
    overall: { count: number; winRate: number | null; avgReturn: number | null };
    byAction: { action: string; count: number; winRate: number | null; avgReturn: number | null }[];
  };
  byAction: {
    action: string;
    byN: { nDays: number; count: number; wins: number; winRate: number; avgReturn: number; avgMaxDrawdown: number | null; avgMaxRunup: number | null }[];
    targetStop?: { nDays: number; targetHitRate: number | null; stopHitRate: number | null; targetOnlyRate: number | null; stopOnlyRate: number | null; targetSamples: number; stopSamples: number }[];
  }[];
  confidenceBuckets: { bucket: string; count: number; winRate: number | null; avgReturn: number | null }[];
  positionBuckets: { bucket: string; count: number; winRate: number | null; avgReturn: number | null }[];
}

const ACTION_TONE: Record<string, string> = {
  '买入': 'text-red-600',
  '卖出': 'text-green-600',
  '持有': 'text-gray-500',
};

export function DeepAnalysisStats() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(false);
  const [focus, setFocus] = useState<string>('买入');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/deep-eval/stats');
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setStats(data);
    } catch {
      setStats(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const focusRow = stats?.byAction.find((a) => a.action === focus);

  return (
    <div className="space-y-4">
      <StatsHeader
        note={<>基于 T+{stats?.summary.primaryN ?? 5} 绝对收益。全局匿名聚合，样本不足显示 --。</>}
        onRefresh={load}
        loading={loading}
      />

      {!stats && !loading && <StatsEmpty>暂无回测数据（深度分析落库后按日回填）</StatsEmpty>}
      {stats && stats.summary.totalRecords === 0 && <StatsEmpty>暂无回测数据（深度分析落库后按日回填）</StatsEmpty>}

      {stats && stats.summary.totalRecords > 0 && (
        <>
          {/* ① 整体指标卡 */}
          <Card className="p-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
              <Metric label={`T+${stats.summary.primaryN} 胜率`} value={stats.summary.overall.winRate == null ? '--' : `${stats.summary.overall.winRate}%`} />
              <Metric label={`T+${stats.summary.primaryN} 均值`} value={signed(stats.summary.overall.avgReturn)} tone={stats.summary.overall.avgReturn != null ? (stats.summary.overall.avgReturn >= 0 ? 'up' : 'down') : undefined} />
              <Metric label="回测样本" value={`${stats.summary.totalEvals}`} />
              <Metric label="分析次数" value={`${stats.summary.totalRecords}`} />
            </div>
          </Card>

          {/* ② 建议方向胜率榜 */}
          <Card className="p-4">
            <div className="text-sm font-medium mb-2 flex items-center gap-1"><Activity className="w-4 h-4" /> 建议方向胜率榜</div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-100 dark:border-gray-800 text-left text-gray-400">
                    <th className="px-2 py-1.5">方向</th>
                    <th className="px-2 py-1.5 text-right">样本</th>
                    <th className="px-2 py-1.5 text-right">T+5胜率</th>
                    <th className="px-2 py-1.5 text-right">T+10胜率</th>
                    <th className="px-2 py-1.5 text-right">T+20胜率</th>
                    <th className="px-2 py-1.5 text-right">T+5均值</th>
                    <th className="px-2 py-1.5 text-right">最大回撤</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.byAction.map((a) => (
                    <tr key={a.action} onClick={() => setFocus(a.action)} className={cn('border-b border-gray-50 dark:border-gray-800/50 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/30', focus === a.action && 'bg-purple-50/50 dark:bg-purple-950/20')}>
                      <td className={cn('px-2 py-1.5 font-medium', ACTION_TONE[a.action] || '')}>{a.action}</td>
                      <td className="px-2 py-1.5 text-right text-gray-500">{a.byN[0]?.count ?? 0}</td>
                      <td className="px-2 py-1.5 text-right font-semibold">{pct(a.byN.find(n => n.nDays === 5)?.winRate, 0)}%</td>
                      <td className="px-2 py-1.5 text-right">{pct(a.byN.find(n => n.nDays === 10)?.winRate, 0)}%</td>
                      <td className="px-2 py-1.5 text-right">{pct(a.byN.find(n => n.nDays === 20)?.winRate, 0)}%</td>
                      <td className={cn('px-2 py-1.5 text-right font-mono', (a.byN.find(n => n.nDays === 5)?.avgReturn ?? 0) >= 0 ? 'text-red-600' : 'text-green-600')}>{signed(a.byN.find(n => n.nDays === 5)?.avgReturn)}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-gray-500">{pct(a.byN.find(n => n.nDays === 5)?.avgMaxDrawdown, 1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {/* ③ 买入目标/止损命中（聚焦买入时展开） */}
          {focus === '买入' && focusRow?.targetStop && (
            <Card className="p-4">
              <div className="text-sm font-medium mb-2 flex items-center gap-1"><Target className="w-4 h-4" /> 买入目标/止损命中（深度分析定价验证）</div>
              <p className="text-xs text-gray-400 mb-2">
                买入建议给出了 targetHigh 和 stopLoss，此处验证 N 日内最高价是否触及目标、最低价是否触及止损——价格被市场验证的程度。
                「先达目标未触止损」= 建议的入场到止盈区间被完整兑现。
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-gray-100 dark:border-gray-800 text-left text-gray-400">
                      <th className="px-2 py-1.5">持有期</th>
                      <th className="px-2 py-1.5 text-right">目标达成率</th>
                      <th className="px-2 py-1.5 text-right">止损触及率</th>
                      <th className="px-2 py-1.5 text-right">先达目标未触止损</th>
                      <th className="px-2 py-1.5 text-right">样本</th>
                    </tr>
                  </thead>
                  <tbody>
                    {focusRow.targetStop.map((r) => (
                      <tr key={r.nDays} className="border-b border-gray-50 dark:border-gray-800/50">
                        <td className="px-2 py-1.5 font-medium">T+{r.nDays}</td>
                        <td className={cn('px-2 py-1.5 text-right font-semibold', r.targetHitRate != null && r.targetHitRate >= 50 ? 'text-red-600' : 'text-gray-600 dark:text-gray-400')}>{pct(r.targetHitRate, 0)}%</td>
                        <td className={cn('px-2 py-1.5 text-right font-semibold', r.stopHitRate != null && r.stopHitRate >= 50 ? 'text-red-600' : 'text-gray-600 dark:text-gray-400')}>{pct(r.stopHitRate, 0)}%</td>
                        <td className={cn('px-2 py-1.5 text-right font-semibold', r.targetOnlyRate != null && r.targetOnlyRate >= 50 ? 'text-red-600' : 'text-gray-600 dark:text-gray-400')}>{pct(r.targetOnlyRate, 0)}%</td>
                        <td className="px-2 py-1.5 text-right text-gray-500">{r.targetSamples}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {/* ④ 置信度 & 仓位校准 */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Card className="p-4">
              <div className="text-sm font-medium mb-1">置信度校准</div>
              <p className="text-xs text-gray-400 mb-2">胜率应随置信度递增（高分高胜率=校准好）</p>
              <CalibTable rows={stats.confidenceBuckets} />
            </Card>
            <Card className="p-4">
              <div className="text-sm font-medium mb-1">仓位校准</div>
              <p className="text-xs text-gray-400 mb-2">重仓建议应比轻仓更准（大仓位平均收益更高）</p>
              <CalibTable rows={stats.positionBuckets} />
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function CalibTable({ rows }: { rows: { bucket: string; count: number; winRate: number | null; avgReturn: number | null }[] }) {
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="border-b border-gray-100 dark:border-gray-800 text-left text-gray-400">
          <th className="px-1 py-1">档位</th>
          <th className="px-1 py-1 text-right">样本</th>
          <th className="px-1 py-1 text-right">T+5胜率</th>
          <th className="px-1 py-1 text-right">T+5均值</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.bucket} className="border-b border-gray-50 dark:border-gray-800/50">
            <td className="px-1 py-1.5 font-medium">{r.bucket}</td>
            <td className="px-1 py-1.5 text-right text-gray-500">{r.count}</td>
            <td className="px-1 py-1.5 text-right font-semibold">{pct(r.winRate, 0)}%</td>
            <td className={cn('px-1 py-1.5 text-right font-mono', (r.avgReturn ?? 0) >= 0 ? 'text-red-600' : 'text-green-600')}>{signed(r.avgReturn)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
