'use client';

/**
 * 自选卡片内「分组」浮层菜单（多组勾选，复制语义：一个标的可在多个组）。
 * 所有点击 stopPropagation 防卡片跳转；再点一次按钮或选中后关闭。
 */

import { Check, FolderPlus } from 'lucide-react';
import { useStockStore } from '@/store';
import { cn } from '@/lib/utils';

interface Props {
  code: string;
  onClose: () => void;
  onCreateGroup: () => void; // 打开分组管理弹窗
}

export function MoveToGroupMenu({ code, onClose, onCreateGroup }: Props) {
  const { groups, watchlist, toggleStockGroup } = useStockStore();
  const inGroups = new Set(
    groups.filter(g => g.stockCodes.includes(code)).map(g => g.id)
  );

  return (
    <div
      className="absolute right-0 top-9 z-20 w-44 bg-white dark:bg-gray-900 rounded-lg shadow-lg border border-gray-100 dark:border-gray-800 py-1"
      onClick={e => e.stopPropagation()}
    >
      <p className="px-3 pt-1 pb-1 text-xs text-gray-400">分组（可多选）</p>
      <div className="max-h-[50vh] overflow-y-auto">
        {groups.map(g => (
          <button
            key={g.id}
            onClick={() => { toggleStockGroup(code, g.id); }}
            className={cn(
              'w-full flex items-center justify-between px-3 py-1.5 text-sm hover:bg-gray-50 dark:hover:bg-gray-800 transition',
              inGroups.has(g.id) ? 'text-blue-600' : 'text-gray-700 dark:text-gray-300',
            )}
          >
            {g.name}
            {inGroups.has(g.id) && <Check className="w-4 h-4" />}
          </button>
        ))}
        {groups.length === 0 && (
          <p className="px-3 py-1.5 text-xs text-gray-400">还没有分组</p>
        )}
      </div>
      <div className="border-t border-gray-100 dark:border-gray-800 mt-1 pt-1">
        <button
          onClick={() => { onClose(); onCreateGroup(); }}
          className="w-full flex items-center gap-1.5 px-3 py-1.5 text-sm text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950 transition"
        >
          <FolderPlus className="w-3.5 h-3.5" />
          新建分组
        </button>
      </div>
    </div>
  );
}
