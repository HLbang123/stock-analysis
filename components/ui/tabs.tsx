'use client';

/**
 * 通用 tab 切换 — 统一全项目的分段切换控件。
 * variant:
 *  - 'segment' : 灰底胶囊组（原 AiScreenPanel 视图切换风格）
 *  - 'pills'   : 横向 chip 组（原 ai 页 mode 切换风格）
 */

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface TabItem<T extends string = string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
}

interface TabsProps<T extends string = string> {
  items: TabItem<T>[];
  value: T;
  onChange: (v: T) => void;
  variant?: 'segment' | 'pills';
  /** segment 选中态颜色，默认 purple；pills 用各色按钮时传 undefined 自行控制 */
  activeCls?: string;
  className?: string;
}

export function Tabs<T extends string = string>({ items, value, onChange, variant = 'segment', activeCls, className }: TabsProps<T>) {
  if (variant === 'segment') {
    return (
      <div className={cn('flex gap-1 p-1 bg-gray-100 dark:bg-gray-800/50 rounded-lg w-fit', className)}>
        {items.map(it => (
          <button
            key={it.value}
            onClick={() => onChange(it.value)}
            className={cn(
              'px-3 py-1 rounded-md text-xs font-medium flex items-center gap-1 transition',
              value === it.value
                ? 'bg-white dark:bg-gray-900 text-purple-600 shadow-sm'
                : 'text-gray-500 dark:text-gray-400',
            )}
          >
            {it.icon}
            {it.label}
          </button>
        ))}
      </div>
    );
  }
  // pills
  return (
    <div className={cn('flex gap-2', className)}>
      {items.map(it => (
        <button
          key={it.value}
          onClick={() => onChange(it.value)}
          className={cn(
            'flex-1 py-2 rounded-lg text-sm font-medium flex items-center justify-center gap-1.5 transition',
            value === it.value
              ? (activeCls ?? 'bg-purple-600 text-white')
              : 'bg-gray-100 dark:bg-gray-800 text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700',
          )}
        >
          {it.icon}
          {it.label}
        </button>
      ))}
    </div>
  );
}
