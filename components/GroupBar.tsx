'use client';

/**
 * 自选分组 tab 栏 — 「全部」+ 各组 + 尾部分组列表按钮。
 * 切换只做前端过滤展示，不触发行情刷新；「管理分组」入口在自选列表头行。
 * 分组多时横向 tab 难找：尾部固定按钮打开全部分组的竖向列表直达。
 */

import { useEffect, useRef, useState } from 'react';
import { List } from 'lucide-react';
import { useStockStore } from '@/store';
import { cn } from '@/lib/utils';

export const ALL_GROUP_ID = 'all'; // 虚拟「全部」tab

interface Props {
  selectedId: string;
  onSelect: (id: string) => void;
}

export function GroupBar({ selectedId, onSelect }: Props) {
  const { groups, watchlist } = useStockStore();
  const [listOpen, setListOpen] = useState(false);
  const listWrapRef = useRef<HTMLDivElement>(null);
  const countOf = (id: string) =>
    id === ALL_GROUP_ID
      ? watchlist.length
      : groups.find(g => g.id === id)?.stockCodes.length ?? 0;

  // 点外部关闭分组列表
  useEffect(() => {
    if (!listOpen) return;
    const handler = (e: MouseEvent) => {
      if (listWrapRef.current && !listWrapRef.current.contains(e.target as Node)) {
        setListOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [listOpen]);

  /** 列表点选分组：切换分组并让横向 tab 滚动到可见 */
  const pickGroup = (id: string) => {
    setListOpen(false);
    onSelect(id);
    requestAnimationFrame(() => {
      document
        .querySelector(`[data-group-tab="${id}"]`)
        ?.scrollIntoView({ inline: id === ALL_GROUP_ID ? 'start' : 'center', block: 'nearest' });
    });
  };

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl p-2 shadow-sm mb-4 flex items-center gap-1.5">
      {/* tab 区：横向滚动 */}
      <div className="flex items-center gap-1.5 overflow-x-auto flex-1 min-w-0">
        <button
          onClick={() => onSelect(ALL_GROUP_ID)}
          data-group-tab={ALL_GROUP_ID}
          className={cn(
            'shrink-0 px-3 py-1.5 rounded-lg text-sm whitespace-nowrap transition',
            selectedId === ALL_GROUP_ID
              ? 'bg-blue-600 text-white'
              : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800',
          )}
        >
          全部
          <span className={cn('ml-1.5 text-xs', selectedId === ALL_GROUP_ID ? 'text-blue-100' : 'text-gray-400')}>{countOf(ALL_GROUP_ID)}</span>
        </button>

        {groups.map(g => (
          <button
            key={g.id}
            onClick={() => onSelect(g.id)}
            data-group-tab={g.id}
            className={cn(
              'shrink-0 px-3 py-1.5 rounded-lg text-sm whitespace-nowrap transition',
              selectedId === g.id
                ? 'bg-blue-600 text-white'
                : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800',
            )}
          >
            {g.name}
            <span className={cn('ml-1.5 text-xs', selectedId === g.id ? 'text-blue-100' : 'text-gray-400')}>{countOf(g.id)}</span>
          </button>
        ))}
      </div>

      {/* 尾部固定按钮：全部分组竖向列表（无分组时不显示） */}
      {groups.length > 0 && (
        <div ref={listWrapRef} className="relative shrink-0">
          <button
            onClick={() => setListOpen(v => !v)}
            title="全部分组"
            aria-label="全部分组"
            className={cn(
              'p-1.5 rounded-lg transition',
              listOpen
                ? 'text-blue-600 bg-blue-50 dark:bg-blue-950'
                : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800 dark:hover:text-gray-300',
            )}
          >
            <List className="w-4 h-4" />
          </button>

          {listOpen && (
            <div
              className="absolute right-0 top-full mt-1 z-50 w-48 bg-white dark:bg-gray-900 rounded-lg shadow-lg border border-gray-100 dark:border-gray-800 py-1"
              onClick={e => e.stopPropagation()}
            >
              <p className="px-3 pt-1 pb-1 text-xs text-gray-400">全部分组</p>
              <div className="max-h-[50vh] overflow-y-auto">
                <button
                  onClick={() => pickGroup(ALL_GROUP_ID)}
                  className={cn(
                    'w-full flex items-center justify-between px-3 py-1.5 text-sm transition hover:bg-gray-50 dark:hover:bg-gray-800',
                    selectedId === ALL_GROUP_ID ? 'text-blue-600 font-medium' : 'text-gray-700 dark:text-gray-300',
                  )}
                >
                  全部
                  <span className="text-xs text-gray-400">{countOf(ALL_GROUP_ID)}</span>
                </button>
                {groups.map(g => (
                  <button
                    key={g.id}
                    onClick={() => pickGroup(g.id)}
                    className={cn(
                      'w-full flex items-center justify-between px-3 py-1.5 text-sm transition hover:bg-gray-50 dark:hover:bg-gray-800',
                      selectedId === g.id ? 'text-blue-600 font-medium' : 'text-gray-700 dark:text-gray-300',
                    )}
                  >
                    <span className="truncate">{g.name}</span>
                    <span className="text-xs text-gray-400 shrink-0 ml-2">{countOf(g.id)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
