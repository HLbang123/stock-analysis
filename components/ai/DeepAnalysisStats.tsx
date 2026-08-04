'use client';

/**
 * 深度分析胜率复盘面板 — 调 /api/ai/deep-eval/stats 展示:
 * 整体指标卡 / 建议方向(买入·持有·卖出)×T+N 胜率榜 / 买入目标·止损命中 / 置信度·仓位校准
 * 主口径 T+5 绝对收益(买入看涨·卖出看跌·持有看震荡)，与 AI 筛选胜率复盘同口径。
 */

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { Activity, Target, Trophy } from 'lucide-react';
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
  byRegime: { regime: string; action: string; count: number; winRate: number | null; avgReturn: number | null }[];
  topPicks: {
    stockCode: string; stockName: string; entryDate: string; entryPrice: number;
    confidence: number | null; position: number | null; targetHigh: number | null; stopLoss: number | null;
    marketRegime: string | null; reasoning: string | null;
    trackCount: number; trackWinRate: number | null; t5Return: number | null;
  }[];
}

const ACTION_TONE: Record<string, string> = {
  '买入': 'text-[var(--color-up)]',
  '卖出': 'text-[var(--color-down)]',
  '持有': 'text-gray-500',
};

const REGIME_LABEL: Record<string, string> = {
  strong: '强势大盘',
  neutral: '中性震荡',
  weak: '弱势大盘',
  unknown: '未知(旧数据)',
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

          {/* ①.5 优质买入建议榜（P5）：高胜率背书 / 高信心的买入建议，点击跳详情 */}
          {stats.topPicks.length > 0 && (
            <Card className="p-4">
              <div className="text-sm font-medium mb-1 flex items-center gap-1"><Trophy className="w-4 h-4 text-[var(--color-warning)]" /> 优质买入建议榜</div>
              <p className="text-xs text-gray-400 mb-2">「高胜率背书」= 该票历史买入建议 T+5 胜率≥50%（样本≥2）；「高信心」= 本次置信度≥70。点击行看标的详情。</p>
              <div className="space-y-1 max-h-72 overflow-y-auto">
                {stats.topPicks.map((p) => {
                  const backed = p.trackCount >= 2 && (p.trackWinRate ?? 0) >= 50;
                  const highConf = (p.confidence ?? 0) >= 70;
                  return (
                    <Link key={`${p.stockCode}-${p.entryDate}`} href={`/stock/${p.stockCode}`} className="flex items-center gap-2 text-xs px-2 py-1.5 rounded-[var(--radius-sm)] bg-gray-50 dark:bg-gray-800/40 hover:bg-gray-100 dark:hover:bg-gray-800 transition">
                      <span className="font-medium text-gray-900 dark:text-gray-100 whitespace-nowrap">{p.stockName}</span>
                      <span className="text-gray-400 text-[10px]">{p.entryDate.slice(4, 6)}-{p.entryDate.slice(6, 8)}</span>
                      {backed && <span className="px-1 py-0.5 rounded text-[10px] bg-[var(--color-up-soft)] text-[var(--color-up)] whitespace-nowrap">胜率背书 {pct(p.trackWinRate, 0)}%·{p.trackCount}次</span>}
                      {highConf && <span className="px-1 py-0.5 rounded text-[10px] bg-[var(--color-warning-soft)] text-[var(--color-warning)] whitespace-nowrap">高信心 {p.confidence}</span>}
                      <span className="flex-1" />
                      {p.position != null && <span className="text-gray-500">仓{p.position}%</span>}
                      {p.t5Return != null ? (
                        <span className={cn('font-mono font-medium', p.t5Return >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]')}>{signed(p.t5Return)}</span>
                      ) : (
                        <span className="text-gray-400">待回填</span>
                      )}
                    </Link>
                  );
                })}
              </div>
            </Card>
          )}

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

          {/* ④ 大盘环境分桶（P3） & 置信度 & 仓位校准 */}
          {stats.byRegime.length > 0 && (
            <Card className="p-4">
              <div className="text-sm font-medium mb-1">大盘环境分桶 · T+5</div>
              <p className="text-xs text-gray-400 mb-2">分析时的大盘强弱对建议质量的影响。弱势盘买入胜率若显著更低，说明应系统性收紧弱势盘的买入建议。</p>
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-100 dark:border-gray-800 text-left text-gray-400">
                    <th className="px-1 py-1">环境</th>
                    <th className="px-1 py-1 text-right">买入胜率</th>
                    <th className="px-1 py-1 text-right">持有胜率</th>
                    <th className="px-1 py-1 text-right">卖出胜率</th>
                  </tr>
                </thead>
                <tbody>
                  {(['strong', 'neutral', 'weak', 'unknown'] as const).map((regime) => {
                    const rows = stats.byRegime.filter((r) => r.regime === regime);
                    if (rows.length === 0) return null;
                    const cell = (action: string) => {
                      const r = rows.find((x) => x.action === action);
                      if (!r) return <td key={action} className="px-1 py-1.5 text-right text-gray-300">--</td>;
                      return (
                        <td key={action} className="px-1 py-1.5 text-right">
                          <span className={cn('font-semibold', ACTION_TONE[action])}>{pct(r.winRate, 0)}%</span>
                          <span className="text-gray-400 ml-1">{r.count}次</span>
                        </td>
                      );
                    };
                    return (
                      <tr key={regime} className="border-b border-gray-50 dark:border-gray-800/50">
                        <td className="px-1 py-1.5 font-medium">{REGIME_LABEL[regime]}</td>
                        {cell('买入')}{cell('持有')}{cell('卖出')}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>
          )}
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
