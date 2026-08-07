'use client';

/**
 * AI 筛选胜率复盘面板 — 调 /api/ai-screen/stats 展示:
 * 策略排行榜 / 因子 IC(含 5 分位胜率)/ LLM A/B / 事件信号 prefer·avoid·watch
 * 主口径 T+5 绝对收益>0。
 */

import { useState, useEffect, useCallback } from 'react';
import { Card } from '@/components/ui/card';
import { Activity } from 'lucide-react';
import { cn } from '@/lib/utils';
import { pct, signed, toneCls, Metric, StatsHeader, StatsEmpty, TuningDetails } from './stats-primitives';

interface Stats {
  primaryN: number;
  summary: { count: number; winRate: number | null; avg: number | null; median: number | null; runCount: number; candidateCount: number; selectedCount: number; pendingEvals: number };
  strategies: any[];
  factorIC: any[];
  llmAB: any[];
  eventSignals: any[];
  byMonth: { month: string; count: number; winRate: number | null; avg: number | null; median: number | null }[];
}

/** 低样本灰显：胜率等百分比在样本过少时降级视觉权重，避免个别样本被当成统计 */
const weak = (count: number, min = 5) => count < min;
const weakCls = (count: number, min = 5) => (weak(count, min) ? 'text-gray-400 dark:text-gray-500' : '');

export function AiScreenStats() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [focus, setFocus] = useState<string>('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch('/api/ai-screen/stats?days=90');
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setStats(data);
      // 首次加载后默认聚焦第一个策略;后续切换 focus 不重新拉取(IC/AB 从已存数据取)
      setFocus((prev) => prev || data.strategies?.[0]?.strategyId || '');
    } catch (e: any) {
      setStats(null);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const focusIC = stats?.factorIC.find((f) => f.strategyId === focus);
  const focusAB = stats?.llmAB.find((f) => f.strategyId === focus);

  return (
    <div className="space-y-4">
      <StatsHeader
        note={<>基于 T+{stats?.primaryN ?? 5} 绝对收益&gt;0 胜率。数据从部署后累积,样本不足时显示 --。</>}
        onRefresh={load}
        loading={loading}
      />

      {!stats && !loading && !error && <StatsEmpty>暂无回测数据</StatsEmpty>}
      {error && (
        <div className="text-center py-10">
          <p className="text-sm text-[var(--color-danger)] mb-2">回测数据加载失败</p>
          <button onClick={load} className="text-xs text-[var(--color-accent)] hover:underline">重试</button>
        </div>
      )}

      {stats && (
        <>
          {/* 整体 */}
          <Card className="p-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
              <Metric label={`T+${stats.primaryN} 胜率`} value={stats.summary.winRate == null ? '--' : `${stats.summary.winRate}%`} />
              <Metric label={`T+${stats.primaryN} 均值`} value={signed(stats.summary.avg)} tone={stats.summary.avg != null ? (stats.summary.avg >= 0 ? 'up' : 'down') : undefined} />
              <Metric label="入选样本" value={`${stats.summary.selectedCount}`} />
              <Metric label="运行次数" value={`${stats.summary.runCount}`} />
            </div>
            {stats.summary.pendingEvals > 0 && (
              <p className="text-xs text-gray-400 mt-2 text-center">
                {stats.summary.pendingEvals} 条入选建议等待 T+5 回填（按日自动补算，未满 5 个交易日属正常）
              </p>
            )}
          </Card>

          {/* 策略排行榜 */}
          <Card className="p-4">
            <div className="text-sm font-medium mb-2 flex items-center gap-1"><Activity className="w-4 h-4" /> 策略排行榜</div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-100 dark:border-gray-800 text-left text-gray-400">
                    <th className="px-2 py-1.5">策略</th>
                    <th className="px-2 py-1.5 text-right">入选/评估</th>
                    <th className="px-2 py-1.5 text-right">T+1胜率</th>
                    <th className="px-2 py-1.5 text-right">T+5胜率</th>
                    <th className="px-2 py-1.5 text-right">T+20胜率</th>
                    <th className="px-2 py-1.5 text-right">T+5均值</th>
                    <th className="px-2 py-1.5 text-right">评分</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.strategies.map((s) => (
                    <tr key={s.strategyId} onClick={() => setFocus(s.strategyId)} className={cn('border-b border-gray-50 dark:border-gray-800/50 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/30', focus === s.strategyId && 'bg-purple-50/50 dark:bg-purple-950/20')}>
                      <td className="px-2 py-1.5 font-medium">{s.strategyName}</td>
                      <td className="px-2 py-1.5 text-right text-gray-500">{s.selectedCount}/{s.evaluatedCount}</td>
                      <td className={cn('px-2 py-1.5 text-right', weakCls(s.byHoldingPeriod?.[1]?.count ?? 0))} title={weak(s.byHoldingPeriod?.[1]?.count ?? 0) ? `样本仅 ${s.byHoldingPeriod?.[1]?.count} 条` : undefined}>{pct(s.byHoldingPeriod?.[1]?.winRate, 0)}%</td>
                      <td className={cn('px-2 py-1.5 text-right font-semibold', weakCls(s.byHoldingPeriod?.[5]?.count ?? 0))} title={weak(s.byHoldingPeriod?.[5]?.count ?? 0) ? `样本仅 ${s.byHoldingPeriod?.[5]?.count} 条` : undefined}>{pct(s.byHoldingPeriod?.[5]?.winRate, 0)}%</td>
                      <td className={cn('px-2 py-1.5 text-right', weakCls(s.byHoldingPeriod?.[20]?.count ?? 0))} title={weak(s.byHoldingPeriod?.[20]?.count ?? 0) ? `样本仅 ${s.byHoldingPeriod?.[20]?.count} 条` : undefined}>{pct(s.byHoldingPeriod?.[20]?.winRate, 0)}%</td>
                      <td className={cn('px-2 py-1.5 text-right font-mono', (s.avgReturn ?? 0) >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]')}>{signed(s.avgReturn)}</td>
                      <td className={cn('px-2 py-1.5 text-right font-mono', weakCls(s.evaluatedCount ?? 0))} title={weak(s.evaluatedCount ?? 0) ? `样本仅 ${s.evaluatedCount} 条` : undefined}>{pct(s.performanceScore, 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {/* 调优细节：月度趋势 / 因子IC / LLM A·B / 事件信号（默认收起；全部为空时不渲染折叠条） */}
          {(stats.byMonth.length > 0 || focusIC || focusAB || stats.eventSignals.length > 0) && (
          <TuningDetails hint="月度趋势 · 因子IC · LLM A/B · 事件信号">
          {/* 月度趋势（调优验证） */}
          {stats.byMonth && stats.byMonth.length > 0 && (
            <Card className="p-4">
              <div className="text-sm font-medium mb-2">月度胜率趋势 · T+{stats.primaryN}</div>
              <p className="text-xs text-gray-400 mb-2">按运行交易日月份聚合入选建议。胜率随月份走高 = 规则/LLM 调优在起效。</p>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {stats.byMonth.map((m) => (
                  <div key={m.month} className={cn('text-center', weakCls(m.count))} title={weak(m.count) ? `样本仅 ${m.count} 条` : undefined}>
                    <div className="text-xs text-gray-400">{m.month.slice(0, 4)}-{m.month.slice(4)}</div>
                    <div className={cn('text-base font-semibold mt-0.5', m.winRate != null ? 'text-gray-900 dark:text-white' : 'text-gray-400')}>
                      {pct(m.winRate, 0)}%
                    </div>
                    <div className="text-[10px] text-gray-400">{m.count}次 {m.avg != null ? signed(m.avg) : '--'}</div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* 因子 IC */}
          {focusIC && (
            <Card className="p-4">
              <div className="text-sm font-medium mb-2">因子 IC 与 5 分位胜率 · {focusIC.strategyName}</div>
              <p className="text-xs text-gray-400 mb-2">IC = 因子分与 T+5 收益的 Spearman 秩相关(&gt;0 有效,越大越强)。分位 Q1=因子分最低→Q5=最高,胜率应随分位递增才说明因子有效。</p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-gray-100 dark:border-gray-800 text-left text-gray-400">
                      <th className="px-2 py-1.5">因子</th>
                      <th className="px-2 py-1.5 text-right">IC</th>
                      <th className="px-2 py-1.5 text-right">样本</th>
                      <th className="px-2 py-1.5 text-right">Q1胜率</th>
                      <th className="px-2 py-1.5 text-right">Q3胜率</th>
                      <th className="px-2 py-1.5 text-right">Q5胜率</th>
                      <th className="px-2 py-1.5 text-right">Q5均值</th>
                    </tr>
                  </thead>
                  <tbody>
                    {focusIC.factors.map((f: any) => (
                      <tr key={f.factor} className="border-b border-gray-50 dark:border-gray-800/50">
                        <td className="px-2 py-1.5 font-medium">{f.factor}</td>
                        <td className={cn('px-2 py-1.5 text-right font-mono', f.ic == null ? 'text-gray-400' : f.ic > 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]')}>{pct(f.ic, 3)}</td>
                        <td className="px-2 py-1.5 text-right text-gray-500">{f.samples}</td>
                        <td className={cn('px-2 py-1.5 text-right', weakCls(f.quantiles?.[0]?.count ?? 0))} title={weak(f.quantiles?.[0]?.count ?? 0) ? `样本仅 ${f.quantiles?.[0]?.count} 条` : undefined}>{pct(f.quantiles?.[0]?.winRate, 0)}%</td>
                        <td className={cn('px-2 py-1.5 text-right', weakCls(f.quantiles?.[2]?.count ?? 0))} title={weak(f.quantiles?.[2]?.count ?? 0) ? `样本仅 ${f.quantiles?.[2]?.count} 条` : undefined}>{pct(f.quantiles?.[2]?.winRate, 0)}%</td>
                        <td className={cn('px-2 py-1.5 text-right', weakCls(f.quantiles?.[4]?.count ?? 0))} title={weak(f.quantiles?.[4]?.count ?? 0) ? `样本仅 ${f.quantiles?.[4]?.count} 条` : undefined}>{pct(f.quantiles?.[4]?.winRate, 0)}%</td>
                        <td className={cn('px-2 py-1.5 text-right font-mono', (f.quantiles?.[4]?.avg ?? 0) >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]')}>{signed(f.quantiles?.[4]?.avg)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {/* LLM A/B */}
          {focusAB && (
            <Card className="p-4">
              <div className="text-sm font-medium mb-2">LLM 重排 A/B · {focusAB.strategyName}</div>
              <p className="text-xs text-gray-400 mb-2">在 topK 池内反算三种选法的 T+5 胜率,判断 LLM 重排是提分还是拖累。</p>
              <div className="grid grid-cols-3 gap-2 text-center text-xs">
                <ABCell label="纯规则分" s={focusAB.pureScreen} />
                <ABCell label="0.6规则+0.4LLM" s={focusAB.fusion} highlight />
                <ABCell label="规则·否决LLM风险" s={focusAB.veto} />
              </div>
              {focusAB.deltaWin != null && (
                <p className={cn('mt-2 text-xs flex items-center gap-1', focusAB.deltaWin >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-warning)]')}>
                  LLM 融合 vs 纯规则：胜率 {focusAB.deltaWin >= 0 ? '+' : ''}{focusAB.deltaWin}pp · 均值 {signed(focusAB.deltaAvg)}
                  → {focusAB.deltaWin >= 0 ? 'LLM 重排加分' : 'LLM 重排拖累'}
                </p>
              )}
            </Card>
          )}

          {/* 事件信号 */}
          {stats.eventSignals.length > 0 && (
            <Card className="p-4">
              <div className="text-sm font-medium mb-2">事件信号复盘(T+5)</div>
              <p className="text-xs text-gray-400 mb-2">LLM 产的标签/催化/风险当信号,按后续收益分类。prefer 可加权重、avoid 可规避。</p>
              <div className="space-y-1 max-h-64 overflow-y-auto">
                {stats.eventSignals.map((s, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs px-2 py-1 rounded bg-gray-50 dark:bg-gray-800/40">
                    <span className={cn('px-1.5 py-0.5 rounded text-white text-[10px]', s.action === 'prefer' ? 'bg-red-500' : s.action === 'avoid' ? 'bg-green-600' : 'bg-gray-400')}>
                      {s.action === 'prefer' ? '偏好' : s.action === 'avoid' ? '规避' : s.action === 'insufficient' ? '不足' : '观察'}
                    </span>
                    <span className="text-gray-400 text-[10px]">{s.type}</span>
                    <span className="flex-1 truncate">{s.signal}</span>
                    <span className="text-gray-500">{s.count}次</span>
                    <span className={cn('font-mono', (s.avgReturn ?? 0) >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]')}>{signed(s.avgReturn)}</span>
                    <span className={cn('font-mono text-gray-600', weakCls(s.count))} title={weak(s.count) ? `样本仅 ${s.count} 条` : undefined}>{pct(s.winRate, 0)}%</span>
                  </div>
                ))}
              </div>
            </Card>
          )}
          </TuningDetails>
          )}
        </>
      )}
    </div>
  );
}

function ABCell({ label, s, highlight }: { label: string; s: any; highlight?: boolean }) {
  return (
    <div className={cn('rounded-lg p-2', highlight ? 'bg-[var(--color-brand-soft)]/70 dark:bg-[var(--color-brand-soft)]/40' : 'bg-gray-50 dark:bg-gray-800/40')}>
      <div className="text-gray-400 text-[10px]">{label}</div>
      <div className={cn('font-semibold text-sm mt-0.5', weakCls(s?.count ?? 0))} title={weak(s?.count ?? 0) ? `样本仅 ${s?.count} 条` : undefined}>
        {s?.winRate == null ? '--' : `${s.winRate}%`}
      </div>
      <div className="text-[10px] text-gray-500">{s?.count ?? 0} 样本</div>
    </div>
  );
}
