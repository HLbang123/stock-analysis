'use client';

/**
 * C1：预警规则 × 周期 regime 方向命中率展示（只读，展示子集）。
 * 数据源 /api/alerts/triggers/regime（alert_rule_triggers × review_calendar_days）。
 *
 * 方向感知口径（与 services/alertRules.ts 的 SELL_RULE_IDS 同源）：
 *   - 卖出/离场侧（R01/R02/R03/R14）：命中 = T+5 下跌
 *   - 买入/机会侧（其余）：命中 = T+5 上涨
 *
 * 只上稳健对比 defense vs neutral；attack 日级簇 < 30 天时只标「样本不足」，不给硬数字。
 * 只做展示，不做任何优先级调整/救回/禁用逻辑。
 */

import { useState, useEffect, useCallback } from 'react';
import { Card } from '@/components/ui/card';
import { AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ALERT_RULES } from '@/services/alertRules';
import { StatsEmpty } from './stats-primitives';

const RULE_NAME: Record<string, string> = Object.fromEntries(ALERT_RULES.map((r) => [r.id, r.name]));
const MIN_DIR_DAYS = 30; // 与脚本/API 一致：日级簇 < 30 天视为样本不足

interface RegimeRow {
  ruleId: string;
  regime: string;
  n5: number;
  dirHit5: number | null;
}

const fmtDate = (s: string | undefined) => (s ? s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) : '--');

export function AlertRuleRegime() {
  const [rows, setRows] = useState<RegimeRow[] | null>(null);
  const [win, setWin] = useState<{ min: string; max: string } | null>(null);
  const [regimeDays, setRegimeDays] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch('/api/alerts/triggers/regime');
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setRows(data.rows ?? []);
      setWin(data.window ?? null);
      setRegimeDays(data.regimeDays ?? {});
    } catch {
      setRows(null);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ruleId -> regime -> row
  const byRule = new Map<string, Map<string, RegimeRow>>();
  for (const r of rows ?? []) {
    let m = byRule.get(r.ruleId);
    if (!m) { m = new Map(); byRule.set(r.ruleId, m); }
    m.set(r.regime, r);
  }

  const attackInsufficient = (regimeDays.attack ?? 0) < MIN_DIR_DAYS;

  const hitCell = (ruleId: string, regime: 'defense' | 'neutral') => {
    const r = byRule.get(ruleId)?.get(regime);
    if (!r) return <td className="px-1.5 py-1.5 text-right text-gray-400">--</td>;
    const low = r.n5 < 30;
    return (
      <td className="px-1.5 py-1.5 text-right">
        <div className={cn('font-semibold', low ? 'text-gray-400 dark:text-gray-500' : 'text-gray-900 dark:text-white')}>
          {r.dirHit5 == null ? '--' : r.dirHit5.toFixed(1) + '%'}
        </div>
        <div className="text-[10px] text-gray-400" title={low ? '样本不足 30 条，仅参考' : undefined}>
          n={r.n5}
        </div>
      </td>
    );
  };

  const attackCell = (ruleId: string) => {
    if (attackInsufficient) {
      return (
        <td className="px-1.5 py-1.5 text-right">
          <span className="inline-block px-1.5 py-0.5 rounded text-[10px] bg-gray-100 dark:bg-gray-800 text-gray-500" title={'attack 日级簇仅 ' + (regimeDays.attack ?? 0) + ' 天，样本不足，不给硬数字'}>
            样本不足
          </span>
        </td>
      );
    }
    const r = byRule.get(ruleId)?.get('attack');
    if (!r || r.dirHit5 == null) return <td className="px-1.5 py-1.5 text-right text-gray-400">--</td>;
    return (
      <td className="px-1.5 py-1.5 text-right">
        <div className="font-semibold text-gray-900 dark:text-white">{r.dirHit5.toFixed(1)}%</div>
        <div className="text-[10px] text-gray-400">n={r.n5}</div>
      </td>
    );
  };

  return (
    <Card className="p-4">
      <div className="text-sm font-medium mb-1 flex items-center gap-1">
        <AlertTriangle className="w-4 h-4" /> 周期可信度（方向感知）
      </div>
      <p className="text-[11px] text-gray-400 mb-2">
        命中口径按信号方向：卖出类信号命中=T+5 下跌，买入类信号命中=T+5 上涨。只展示稳健对比 收缩 vs 震荡；活跃期样本不足，不给硬数字。
      </p>

      {error && (
        <div className="text-center py-8">
          <p className="text-sm text-[var(--color-danger)] mb-2">数据加载失败</p>
          <button onClick={load} className="text-xs text-[var(--color-accent)] hover:underline">重试</button>
        </div>
      )}
      {!error && !loading && rows && rows.length === 0 && (
        <StatsEmpty>暂无可匹配 regime 的预警触发记录</StatsEmpty>
      )}

      {!error && rows && rows.length > 0 && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-800 text-left text-gray-400">
                  <th className="px-1.5 py-1">规则</th>
                  <th className="px-1.5 py-1 text-right">收缩 defense</th>
                  <th className="px-1.5 py-1 text-right">震荡 neutral</th>
                  <th className="px-1.5 py-1 text-right">活跃 attack</th>
                </tr>
              </thead>
              <tbody>
                {ALERT_RULES.map((rule) => (
                  <tr key={rule.id} className="border-b border-gray-50 dark:border-gray-800/50">
                    <td className="px-1.5 py-1.5 font-medium">
                      <span className={cn('mr-1 text-[10px] px-1 py-0.5 rounded', rule.id === 'R01' ? 'bg-[var(--color-danger-soft)] text-[var(--color-danger)]' : 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]')}>{rule.id}</span>
                      {RULE_NAME[rule.id] ?? rule.id}
                    </td>
                    {hitCell(rule.id, 'defense')}
                    {hitCell(rule.id, 'neutral')}
                    {attackCell(rule.id)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-gray-400">
            <span>数据窗口：{fmtDate(win?.min)} ~ {fmtDate(win?.max)}</span>
            <span>日级簇：收缩 {regimeDays.defense ?? '--'} 天 · 震荡 {regimeDays.neutral ?? '--'} 天 · 活跃 {regimeDays.attack ?? '--'} 天</span>
          </div>
        </>
      )}
    </Card>
  );
}
