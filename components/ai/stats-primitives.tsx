'use client';

/**
 * 胜率复盘面板共享原语 — DeepAnalysisStats 与 AiScreenStats 共用。
 * 统一的格式化函数 + Metric 指标卡 + 面板头部(刷新) + 空态。
 */

import type { ReactNode } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';

export const pct = (v: number | null | undefined, d = 1) => (v == null ? '--' : v.toFixed(d));
export const signed = (v: number | null | undefined, d = 2) => (v == null ? '--' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}`);

/** A股语义：涨红跌绿 */
export const toneCls = (v: number | null | undefined) =>
  v == null ? 'text-gray-400' : v >= 0 ? 'text-red-600' : 'text-green-600';

export function Metric({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div>
      <div className="text-xs text-gray-400">{label}</div>
      <div className={cn('text-lg font-semibold mt-0.5', tone === 'up' ? 'text-red-600' : tone === 'down' ? 'text-green-600' : 'text-gray-900 dark:text-white')}>{value}</div>
    </div>
  );
}

/** 面板头部：说明文案 + 刷新按钮 */
export function StatsHeader({ note, onRefresh, loading }: { note: ReactNode; onRefresh: () => void; loading: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <p className="text-xs text-gray-500 dark:text-gray-400">{note}</p>
      <button onClick={onRefresh} disabled={loading} className="text-xs text-purple-600 flex items-center gap-1 disabled:opacity-50">
        {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} 刷新
      </button>
    </div>
  );
}

/** 空态 */
export function StatsEmpty({ children }: { children: ReactNode }) {
  return <div className="text-center py-12 text-gray-400 text-sm">{children}</div>;
}
