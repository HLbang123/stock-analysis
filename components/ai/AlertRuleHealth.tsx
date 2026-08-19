'use client';

/**
 * 预警规则健康卡 — AI 页「胜率复盘」tab 顶部。
 * 数据源 /api/alerts/triggers/stats（alert_rule_triggers 聚合，T+5 回填后才有样本）。
 * 目的：让规则质量持续可见——哪条规则在触发、触发后涨跌如何、近 30 天趋势。
 * 注意：胜率是绝对口径（T+5 > 0），弱市下基准线可能低于 50%，对照看趋势而非绝对高低。
 */

import { useState, useEffect, useCallback, Fragment } from 'react';
import { Card } from '@/components/ui/card';
import { Activity } from 'lucide-react';
import { cn } from '@/lib/utils';
import { pct, signed, StatsEmpty } from './stats-primitives';
import { ALERT_RULES } from '@/services/alertRules';

const RULE_NAME: Record<string, string> = Object.fromEntries(ALERT_RULES.map((r) => [r.id, r.name]));

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

interface RuleAgg {
  ruleId: string;
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
  const [rules, setRules] = useState<RuleAgg[] | null>(null);
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
      setRules(data.rules ?? []);
    } catch {
      setStats(null);
      setRules(null);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const rows = (stats ?? []).filter((s) => s.count >= 3);
  const ruleRows = (rules ?? []).filter((s) => s.count >= 3);
  const pending = (stats ?? []).filter((s) => s.count < 3).length;

  return (
    <Card className="p-4">
      <div className="text-sm font-medium mb-1 flex items-center gap-1"><Activity className="w-4 h-4" /> 预警规则健康</div>

      {error && (
        <div className="text-center py-8">
          <p className="text-sm text-[var(--color-danger)] mb-2">数据加载失败</p>
          <button onClick={load} className="text-xs text-[var(--color-accent)] hover:underline">重试</button>
        </div>
      )}
      {!error && !loading && stats && ruleRows.length === 0 && (
        <StatsEmpty>暂无预警触发记录（检查预警后自动落库，回填后展示）</StatsEmpty>
      )}

      {ruleRows.length > 0 && (
        <div className="overflow-x-auto mt-2">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-100 dark:border-gray-800 text-left text-gray-400">
                <th className="px-1 py-1">规则</th>
                <th className="px-1 py-1 text-right">样本</th>
                <th className="px-1 py-1 text-right">T+5胜率</th>
                <th className="px-1 py-1 text-right">T+5均值</th>
                <th className="px-1 py-1 text-right">近30天胜率</th>
                <th className="px-1 py-1 text-right">近30天样本</th>
              </tr>
            </thead>
            <tbody>
              {ruleRows.map((rule) => {
                const subs = rows.filter((s) => s.ruleId === rule.ruleId);
                return (
                  <Fragment key={rule.ruleId}>
                    {/* 规则级聚合行 */}
                    <tr className="border-b border-gray-50 dark:border-gray-800/50 bg-gray-50/50 dark:bg-gray-800/20">
                      <td className="px-1 py-1.5 font-medium">
                        <span className={cn('mr-1 text-[10px] px-1 py-0.5 rounded', rule.ruleId === 'R01' ? 'bg-[var(--color-danger-soft)] text-[var(--color-danger)]' : 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]')}>{rule.ruleId}</span>
                        {RULE_NAME[rule.ruleId] ?? rule.ruleId}
                        {subs.length > 1 && <span className="text-gray-400 text-[10px] ml-1">（{subs.length}子信号）</span>}
                      </td>
                      <td className="px-1 py-1.5 text-right text-gray-600 dark:text-gray-300 font-medium">{rule.count}</td>
                      <td className={cn('px-1 py-1.5 text-right font-semibold', weakCls(rule.count))} title={weak(rule.count) ? `样本仅 ${rule.count} 条` : undefined}>{pct(rule.winRate5, 0)}%</td>
                      <td className={cn('px-1 py-1.5 text-right font-mono', weakCls(rule.count), (rule.avgReturn5 ?? 0) >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]')}>{signed(rule.avgReturn5)}</td>
                      <td className={cn('px-1 py-1.5 text-right', weakCls(rule.recent30Count, 5))} title={rule.recent30Count < 5 ? `近30天样本仅 ${rule.recent30Count} 条` : undefined}>{rule.recent30Count > 0 ? `${pct(rule.recent30WinRate, 0)}%` : '--'}</td>
                      <td className="px-1 py-1.5 text-right text-gray-400">{rule.recent30Count}</td>
                    </tr>
                    {/* 子信号明细：多子信号规则（R01/R02 阶梯）展开，单信号规则不再重复 */}
                    {subs.length > 1 && subs.map((s) => (
                      <tr key={`${s.ruleId}:${s.subLabel}`} className="border-b border-gray-50 dark:border-gray-800/50">
                        <td className="px-1 py-1.5 pl-4 text-gray-500 dark:text-gray-400">↳ {s.subLabel}</td>
                        <td className="px-1 py-1.5 text-right text-gray-500">{s.count}</td>
                        <td className={cn('px-1 py-1.5 text-right', weakCls(s.count))} title={weak(s.count) ? `样本仅 ${s.count} 条` : undefined}>{pct(s.winRate5, 0)}%</td>
                        <td className={cn('px-1 py-1.5 text-right font-mono', weakCls(s.count), (s.avgReturn5 ?? 0) >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]')}>{signed(s.avgReturn5)}</td>
                        <td className={cn('px-1 py-1.5 text-right', weakCls(s.recent30Count, 5))} title={s.recent30Count < 5 ? `近30天样本仅 ${s.recent30Count} 条` : undefined}>{s.recent30Count > 0 ? `${pct(s.recent30WinRate, 0)}%` : '--'}</td>
                        <td className="px-1 py-1.5 text-right text-gray-400">{s.recent30Count}</td>
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {pending > 0 && <p className="text-[10px] text-gray-400 mt-1.5">{pending} 个子信号样本不足 3 条未列出</p>}
        </div>
      )}
    </Card>
  );
}
