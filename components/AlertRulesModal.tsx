'use client';

import { X } from 'lucide-react';
import { ALERT_RULES, isBuyRule, REFERENCE_RULE_IDS } from '@/services/alertRules';
import type { AlertRule } from '@/types';
import { cn } from '@/lib/utils';

interface Props {
  onClose: () => void;
}

const levelColor = (level: string) =>
  level === 'CRITICAL' ? 'bg-red-100 text-red-600 dark:bg-red-950 dark:text-red-400' :
  level === 'WARNING' ? 'bg-amber-100 text-amber-600 dark:bg-amber-950 dark:text-amber-400' :
  'bg-blue-100 text-blue-600 dark:bg-blue-950 dark:text-blue-400';
const levelLabel = (level: string) =>
  level === 'CRITICAL' ? '严重' : level === 'WARNING' ? '注意' : '关注';

function RuleGroup({ title, hint, rules }: { title: string; hint: string; rules: AlertRule[] }) {
  if (rules.length === 0) return null;
  return (
    <div className="mb-4">
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
        {title} <span className="text-xs text-gray-400 font-normal">· {hint}</span>
      </h3>
      <div className="space-y-2">
        {rules.map(r => (
          <div key={r.id} className="border border-gray-100 dark:border-gray-800 rounded-lg p-2.5">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className="text-xs font-mono text-gray-400">{r.id}</span>
              <span className="text-sm font-medium text-gray-800 dark:text-gray-200">{r.name}</span>
              <span className={cn('text-xs px-1.5 py-0.5 rounded', levelColor(r.level))}>{levelLabel(r.level)}</span>
              {!r.isEnabled && <span className="text-xs text-gray-400">（已停用）</span>}
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed mb-1">{r.description}</p>
            <p className="text-xs text-blue-600 dark:text-blue-400">建议：{r.suggestion}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function AlertRulesModal({ onClose }: Props) {
  const buy = ALERT_RULES.filter(r => isBuyRule(r.id) && !REFERENCE_RULE_IDS.has(r.id));
  const sell = ALERT_RULES.filter(r => !isBuyRule(r.id) && !REFERENCE_RULE_IDS.has(r.id));
  const ref = ALERT_RULES.filter(r => REFERENCE_RULE_IDS.has(r.id));

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-gray-900 w-full sm:max-w-lg max-h-[80vh] rounded-t-2xl sm:rounded-2xl overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-800">
          <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">预警规则说明</h3>
          <button
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-lg transition"
            aria-label="关闭"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <RuleGroup title="卖出 / 风险信号" hint="破位·见顶·离场" rules={sell} />
          <RuleGroup title="买入 / 机会信号" hint="金叉·突破·站稳" rules={buy} />
          <RuleGroup title="参考信号" hint="筹码等辅助判断" rules={ref} />
        </div>
      </div>
    </div>
  );
}
