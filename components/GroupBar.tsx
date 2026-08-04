'use client';

/**
 * 自选分组 tab 栏 — 「全部」+ 各组 + 新建入口。
 * 切换只做前端过滤展示，不触发行情刷新。
 */

import { FolderPlus } from 'lucide-react';
import { useStockStore } from '@/store';
import { cn } from '@/lib/utils';

export const ALL_GROUP_ID = 'all'; // 虚拟「全部」tab

interface Props {
  selectedId: string;
  onSelect: (id: string) => void;
  onManage: () => void;
}

export function GroupBar({ selectedId, onSelect, onManage }: Props) {
  const { groups, watchlist } = useStockStore();
  const countOf = (id: string) =>
    id === ALL_GROUP_ID
      ? watchlist.length
      : watchlist.filter(s => s.groupId === id).length;

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl p-2 shadow-sm mb-4 flex items-center gap-1.5 overflow-x-auto">
      <button
        onClick={() => onSelect(ALL_GROUP_ID)}
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

      <button
        onClick={onManage}
        className="shrink-0 px-2.5 py-1.5 rounded-lg text-sm text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950 whitespace-nowrap flex items-center gap-1 transition"
      >
        <FolderPlus className="w-3.5 h-3.5" />
        新建分组
      </button>
    </div>
  );
}
