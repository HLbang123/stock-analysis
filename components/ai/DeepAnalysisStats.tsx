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
import { pct, signed, Metric, StatsHeader, StatsEmpty, TuningDetails } from './stats-primitives';

interface Stats {
  summary: {
    primaryN: number;
    totalRecords: number;
    totalEvals: number;
    pendingEvals: number;
    overall: { count: number; winRate: number | null; avgReturn: number | null };
    byAction: { action: string; count: number; winRate: number | null; avgReturn: number | null }[];
  };
  byAction: {
    action: string;
    byN: { nDays: number; count: number; wins: number; winRate: number; avgReturn: number; avgMaxDrawdown: number | null; avgMaxRunup: number | null; payoff: number | null }[];
    targetStop?: { nDays: number; targetHitRate: number | null; stopHitRate: number | null; targetOnlyRate: number | null; stopOnlyRate: number | null; targetSamples: number; stopSamples: number }[];
  }[];
  confidenceBuckets: { bucket: string; count: number; winRate: number | null; avgReturn: number | null }[];
  positionBuckets: { bucket: string; count: number; winRate: number | null; avgReturn: number | null }[];
  byRegime: { regime: string; action: string; count: number; winRate: number | null; avgReturn: number | null }[];
  byMonth: { month: string; count: number; winRate: number | null; avgReturn: number | null }[];
  topPicks: {
    backed: TopPick[];
    highConf: TopPick[];
  };
}

/** 低样本阈值：胜率/命中率等百分比在样本过少时灰显，避免个别样本被当成统计 */
const weak = (count: number, min = 5) => count < min;
const weakCls = (count: number, min = 5) => (weak(count, min) ? 'text-gray-400 dark:text-gray-500' : '');

interface TopPick {
  stockCode: string; stockName: string; entryDate: string; entryPrice: number;
  confidence: number | null; position: number | null; targetHigh: number | null; stopLoss: number | null;
  marketRegime: string | null; reasoning: string | null;
  buyCount: number; trackCount: number; trackWinRate: number | null; t5Return: number | null;
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
  const [error, setError] = useState(false);
  const [focus, setFocus] = useState<string>('买入');

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch('/api/ai/deep-eval/stats');
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

  const focusRow = stats?.byAction.find((a) => a.action === focus);

  return (
    <div className="space-y-4">
      <StatsHeader
        note={<>基于 T+{stats?.summary.primaryN ?? 5} 绝对收益。全局匿名聚合，样本不足显示 --。</>}
        onRefresh={load}
        loading={loading}
      />

      {!stats && !loading && !error && <StatsEmpty>暂无回测数据（深度分析落库后按日回填）</StatsEmpty>}
      {error && (
        <div className="text-center py-10">
          <p className="text-sm text-[var(--color-danger)] mb-2">回测数据加载失败</p>
          <button onClick={load} className="text-xs text-[var(--color-accent)] hover:underline">重试</button>
        </div>
      )}
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
            {stats.summary.pendingEvals > 0 && (
              <p className="text-xs text-gray-400 mt-2 text-center">
                {stats.summary.pendingEvals} 条记录等待 T+5 回填（按日自动补算，未满 5 个交易日属正常）
              </p>
            )}
          </Card>

          {/* ①.5 优质买入建议榜（P5）：按股票合并，每票一行；高胜率背书 / 近期高信心两组 */}
          {stats.topPicks.backed.length + stats.topPicks.highConf.length > 0 && (
            <Card className="p-4">
              <div className="text-sm font-medium mb-1 flex items-center gap-1"><Trophy className="w-4 h-4 text-[var(--color-warning)]" /> 优质买入建议榜</div>
              <p className="text-xs text-gray-400 mb-2">按标的合并（取最近一次分析）。「高胜率背书」= 该票历史买入建议 T+5 胜率≥50% 且样本≥2；「近期高信心」= 近30天置信度≥70。点击行看标的详情。</p>
              <TopPickGroup title="高胜率背书" rows={stats.topPicks.backed} />
              <div className="h-2" />
              <TopPickGroup title="近期高信心" rows={stats.topPicks.highConf} />
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
                    <th className="px-2 py-1.5 text-right">盈亏比</th>
                    <th className="px-2 py-1.5 text-right">最大回撤</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.byAction.map((a) => (
                    <tr key={a.action} onClick={() => setFocus(a.action)} className={cn('border-b border-gray-50 dark:border-gray-800/50 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/30', focus === a.action && 'bg-[var(--color-brand-soft)]/60 dark:bg-[var(--color-brand-soft)]/40')}>
                      <td className={cn('px-2 py-1.5 font-medium', ACTION_TONE[a.action] || '')}>{a.action}</td>
                      <td className="px-2 py-1.5 text-right text-gray-500">{a.byN[0]?.count ?? 0}</td>
                      {[5, 10, 20].map((n) => {
                        const row = a.byN.find(x => x.nDays === n);
                        return (
                          <td key={n} title={row && weak(row.count) ? `样本仅 ${row.count} 条，胜率不具统计意义` : undefined}
                            className={cn('px-2 py-1.5 text-right', weakCls(row?.count ?? 0), n === 5 && 'font-semibold')}>
                            {pct(row?.winRate, 0)}%
                          </td>
                        );
                      })}
                      <td className={cn('px-2 py-1.5 text-right font-mono', (a.byN.find(n => n.nDays === 5)?.avgReturn ?? 0) >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]')}>{signed(a.byN.find(n => n.nDays === 5)?.avgReturn)}</td>
                      <td className="px-2 py-1.5 text-right font-mono">
                        {a.action === '买入' && a.byN.find(n => n.nDays === 5)?.payoff != null ? (
                          <span title="平均盈 ÷ 平均亏（期望值）" className={cn((a.byN.find(n => n.nDays === 5)?.payoff ?? 0) >= 1 ? 'text-[var(--color-up)]' : 'text-[var(--color-warning)]')}>
                            {a.byN.find(n => n.nDays === 5)?.payoff}x
                          </span>
                        ) : <span className="text-gray-300 dark:text-gray-600">--</span>}
                      </td>
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
                        <td className={cn('px-2 py-1.5 text-right font-semibold', r.targetHitRate != null && r.targetHitRate >= 50 ? 'text-[var(--color-up)]' : 'text-gray-600 dark:text-gray-400')}>{pct(r.targetHitRate, 0)}%</td>
                        <td className={cn('px-2 py-1.5 text-right font-semibold', r.stopHitRate != null && r.stopHitRate >= 50 ? 'text-[var(--color-up)]' : 'text-gray-600 dark:text-gray-400')}>{pct(r.stopHitRate, 0)}%</td>
                        <td className={cn('px-2 py-1.5 text-right font-semibold', r.targetOnlyRate != null && r.targetOnlyRate >= 50 ? 'text-[var(--color-up)]' : 'text-gray-600 dark:text-gray-400')}>{pct(r.targetOnlyRate, 0)}%</td>
                        <td className="px-2 py-1.5 text-right text-gray-500">{r.targetSamples}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {/* 调优细节：月度趋势 / 大盘环境分桶 / 置信度·仓位校准（默认收起） */}
          <TuningDetails hint="月度趋势 · 大盘分桶 · 校准">
          {/* ②.5 月度趋势（验证 P2 校准注入是否逐步起效） */}
          {stats.byMonth.length > 0 && (
            <Card className="p-4">
              <div className="text-sm font-medium mb-2">月度胜率趋势 · T+5</div>
              <p className="text-xs text-gray-400 mb-2">按分析落库月份聚合。校准注入（P2）上线后，若胜率随月份走高说明自校准在起效。</p>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {stats.byMonth.map((m) => (
                  <div key={m.month} className={cn('text-center', weakCls(m.count))} title={weak(m.count) ? `样本仅 ${m.count} 条` : undefined}>
                    <div className="text-xs text-gray-400">{m.month.slice(0, 4)}-{m.month.slice(4)}</div>
                    <div className={cn('text-base font-semibold mt-0.5', m.winRate != null ? 'text-gray-900 dark:text-white' : 'text-gray-400')}>
                      {pct(m.winRate, 0)}%
                    </div>
                    <div className="text-[10px] text-gray-400">{m.count}次 {m.avgReturn != null ? signed(m.avgReturn) : '--'}</div>
                  </div>
                ))}
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
                        <td key={action} className={cn('px-1 py-1.5 text-right', weakCls(r.count, 3))} title={weak(r.count, 3) ? `样本仅 ${r.count} 条` : undefined}>
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
              <ConfidenceViolation buckets={stats.confidenceBuckets} />
            </Card>
            <Card className="p-4">
              <div className="text-sm font-medium mb-1">仓位校准</div>
              <p className="text-xs text-gray-400 mb-2">重仓建议应比轻仓更准（大仓位平均收益更高）</p>
              <CalibTable rows={stats.positionBuckets} />
            </Card>
          </div>
          </TuningDetails>
        </>
      )}
    </div>
  );
}

/** 置信度序错误检测（③）：高信心档胜率反而低于中/低档 → 校准失效报警 */
function ConfidenceViolation({ buckets }: { buckets: { bucket: string; count: number; winRate: number | null }[] }) {
  const get = (prefix: string) => buckets.find((b) => b.bucket.startsWith(prefix));
  const high = get('高'), mid = get('中'), low = get('低');
  const valid = (b?: { count: number; winRate: number | null }) => b && b.count >= 3 && b.winRate != null ? b : null;
  const h = valid(high), m = valid(mid), l = valid(low);
  const broken =
    (h && m && h.winRate! < m.winRate!) ||
    (h && l && h.winRate! < l.winRate!);
  if (!broken) return null;
  return (
    <div className="mt-2 px-2 py-1.5 rounded-[var(--radius-md)] bg-[var(--color-danger-soft)] border border-[var(--color-danger)]/30 text-xs text-[var(--color-danger)]">
      校准失效：高信心档胜率（{pct(h?.winRate, 0)}%）低于{(m && h!.winRate! < m.winRate!) ? `中信心档（${pct(m.winRate, 0)}%）` : ''}{l && h!.winRate! < l.winRate! ? `低信心档（${pct(l.winRate, 0)}%）` : ''}——AI 在过度自信，建议关注 prompt 校准效果
    </div>
  );
}

function TopPickGroup({ title, rows }: { title: string; rows: TopPick[] }) {
  if (rows.length === 0) return null;
  return (
    <div>
      <div className="text-xs font-medium text-gray-500 mb-1.5">{title}（{rows.length}）</div>
      <div className="space-y-1 max-h-48 overflow-y-auto">
        {rows.map((p) => (
          <Link key={p.stockCode} href={`/stock/${p.stockCode}`} className="flex items-center gap-2 text-xs px-2 py-1.5 rounded-[var(--radius-sm)] bg-gray-50 dark:bg-gray-800/40 hover:bg-gray-100 dark:hover:bg-gray-800 transition">
            <span className="font-medium text-gray-900 dark:text-gray-100 whitespace-nowrap">{p.stockName}</span>
            <span className="text-gray-400 text-[10px]">{p.entryDate.slice(4, 6)}-{p.entryDate.slice(6, 8)}</span>
            {p.trackCount >= 2 && p.trackWinRate != null && (
              <span className="px-1 py-0.5 rounded text-[10px] bg-[var(--color-up-soft)] text-[var(--color-up)] whitespace-nowrap">胜率 {pct(p.trackWinRate, 0)}%·{p.trackCount}次</span>
            )}
            {p.confidence != null && (
              <span className={cn('px-1 py-0.5 rounded text-[10px] whitespace-nowrap', p.confidence >= 70 ? 'bg-[var(--color-warning-soft)] text-[var(--color-warning)]' : 'bg-gray-100 dark:bg-gray-700 text-gray-500')}>
                信心 {p.confidence}
              </span>
            )}
            {p.buyCount > 1 && <span className="text-gray-400 text-[10px] whitespace-nowrap">建议{p.buyCount}次</span>}
            <span className="flex-1" />
            {p.t5Return != null ? (
              <span className={cn('font-mono font-medium', p.t5Return >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]')}>{signed(p.t5Return)}</span>
            ) : (
              <span className="text-gray-400">待回填</span>
            )}
          </Link>
        ))}
      </div>
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
            <td className={cn('px-1 py-1.5 text-right font-mono', (r.avgReturn ?? 0) >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]')}>{signed(r.avgReturn)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
