'use client';

/**
 * 预警规则健康卡 — AI 页「胜率复盘」tab 顶部。
 * 数据源 /api/alerts/triggers/stats（alert_rule_triggers 聚合，T+5 回填后才有样本）。
 * 目的：让规则质量持续可见——哪条规则在触发、触发后涨跌如何、近 30 天趋势。
 * 注意：胜率是绝对口径（T+5 > 0），弱市下基准线可能低于 50%，对照看趋势而非绝对高低。
 */

import { useState, useEffect, useCallback } from 'react';
import { Card } from '@/components/ui/card';
import { Activity } from 'lucide-react';
import { cn } from '@/lib/utils';
import { pct, signed, StatsHeader, StatsEmpty } from './stats-primitives';

interface RuleStat {
  ruleId: string;
  subLabel: string;
  count: number;
  winRate5: number | null;
  avgReturn5: number | null;
  winRate10: number | null;
  recent30Count: number;
  recent30WinRate: number | null;
}

const weak = (count: number, min = 10) => count < min;
const weakCls = (count: number, min = 10) => (weak(count, min) ? 'text-gray-400 dark:text-gray-500' : '');

export function AlertRuleHealth() {
  const [stats, setStats] = useState<RuleStat[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch('/api/alerts/triggers/stats?days=180');
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setStats(data.stats ?? []);
    } catch {
      setStats(null);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const rows = (stats ?? []).filter((s) => s.count >= 3);
  const pending = (stats ?? []).filter((s) => s.count < 3).length;

  return (
    <Card className="p-4">
      <div className="text-sm font-medium mb-1 flex items-center gap-1"><Activity className="w-4 h-4" /> 预警规则健康</div>
      <p className="text-xs text-gray-400 mb-2">
        在线触发落库后 T+5 真实收益。弱市下胜率普遍低于 50%，重点看趋势与相对高低；样本 &lt;10 灰显。
      </p>
      <StatsHeader
        note={<>触发后 T+5 绝对收益&gt;0 胜率。数据从落库日起累积，需触发 + 回填双就绪。</>}
        onRefresh={load}
        loading={loading}
      />

      {error && (
        <div className="text-center py-8">
          <p className="text-sm text-[var(--color-danger)] mb-2">数据加载失败</p>
          <button onClick={load} className="text-xs text-[var(--color-accent)] hover:underline">重试</button>
        </div>
      )}
      {!error && !loading && stats && rows.length === 0 && (
        <StatsEmpty>暂无预警触发记录（检查预警后自动落库，回填后展示）</StatsEmpty>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto mt-2">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-100 dark:border-gray-800 text-left text-gray-400">
                <th className="px-1 py-1">子信号</th>
                <th className="px-1 py-1 text-right">样本</th>
                <th className="px-1 py-1 text-right">T+5胜率</th>
                <th className="px-1 py-1 text-right">T+5均值</th>
                <th className="px-1 py-1 text-right">近30天胜率</th>
                <th className="px-1 py-1 text-right">近30天样本</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={`${s.ruleId}:${s.subLabel}`} className="border-b border-gray-50 dark:border-gray-800/50">
                  <td className="px-1 py-1.5 font-medium">
                    <span className={cn('mr-1 text-[10px] px-1 py-0.5 rounded', s.ruleId === 'R01' ? 'bg-[var(--color-danger-soft)] text-[var(--color-danger)]' : 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]')}>{s.ruleId}</span>
                    {s.subLabel}
                  </td>
                  <td className="px-1 py-1.5 text-right text-gray-500">{s.count}</td>
                  <td className={cn('px-1 py-1.5 text-right font-semibold', weakCls(s.count))} title={weak(s.count) ? `样本仅 ${s.count} 条` : undefined}>{pct(s.winRate5, 0)}%</td>
                  <td className={cn('px-1 py-1.5 text-right font-mono', weakCls(s.count), (s.avgReturn5 ?? 0) >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]')}>{signed(s.avgReturn5)}</td>
                  <td className={cn('px-1 py-1.5 text-right', weakCls(s.recent30Count, 5))} title={s.recent30Count < 5 ? `近30天样本仅 ${s.recent30Count} 条` : undefined}>{s.recent30Count > 0 ? `${pct(s.recent30WinRate, 0)}%` : '--'}</td>
                  <td className="px-1 py-1.5 text-right text-gray-400">{s.recent30Count}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {pending > 0 && <p className="text-[10px] text-gray-400 mt-1.5">{pending} 个子信号样本不足 3 条未列出</p>}
        </div>
      )}
    </Card>
  );
}
