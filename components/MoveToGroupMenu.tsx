'use client';

/**
 * 自选卡片内「移动到分组」浮层菜单。
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
  const { groups, watchlist, moveStockToGroup } = useStockStore();
  const currentId = watchlist.find(s => s.code === code)?.groupId; // undefined = 未分组

  return (
    <div
      className="absolute right-0 top-9 z-20 w-44 bg-white dark:bg-gray-900 rounded-lg shadow-lg border border-gray-100 dark:border-gray-800 py-1"
      onClick={e => e.stopPropagation()}
    >
      <p className="px-3 pt-1 pb-1 text-xs text-gray-400">移动到分组</p>
      <button
        onClick={() => { moveStockToGroup(code, undefined); onClose(); }}
        className={cn(
          'w-full flex items-center justify-between px-3 py-1.5 text-sm hover:bg-gray-50 dark:hover:bg-gray-800 transition',
          currentId == null ? 'text-blue-600' : 'text-gray-700 dark:text-gray-300',
        )}
      >
        未分组
        {currentId == null && <Check className="w-4 h-4" />}
      </button>
      {groups.map(g => (
        <button
          key={g.id}
          onClick={() => { moveStockToGroup(code, g.id); onClose(); }}
          className={cn(
            'w-full flex items-center justify-between px-3 py-1.5 text-sm hover:bg-gray-50 dark:hover:bg-gray-800 transition',
            currentId === g.id ? 'text-blue-600' : 'text-gray-700 dark:text-gray-300',
          )}
        >
          {g.name}
          {currentId === g.id && <Check className="w-4 h-4" />}
        </button>
      ))}
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
