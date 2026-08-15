'use client';

/**
 * 自选分组管理弹窗 — 新建 / 重命名 / 删除分组。
 * 删除弹窗两选项：仅删分组（标的留自选）/ 连分组自选一起删（其他组也有的保留）。
 */

import { useState } from 'react';
import { Plus, Pencil, Trash2, Check } from 'lucide-react';
import { useStockStore } from '@/store';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';

const MAX_NAME_LEN = 12;

export function GroupManageModal({ onClose }: { onClose: () => void }) {
  const { groups, addGroup, renameGroup, deleteGroup } = useStockStore();
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string; count: number } | null>(null);
  const [deleteWithStocks, setDeleteWithStocks] = useState(false);

  const countOf = (id: string) => groups.find(g => g.id === id)?.stockCodes.length ?? 0;

  const handleCreate = () => {
    if (addGroup(newName)) {
      setNewName('');
      toast.success('分组已创建');
    } else {
      toast.error('分组名称无效或已存在');
    }
  };

  const startRename = (id: string, name: string) => {
    setEditingId(id);
    setEditName(name);
  };

  const saveRename = (id: string) => {
    if (renameGroup(id, editName)) {
      setEditingId(null);
      toast.success('已重命名');
    } else {
      toast.error('分组名称无效或已存在');
    }
  };

  const handleDelete = () => {
    if (!deleteTarget) return;
    deleteGroup(deleteTarget.id, deleteWithStocks);
    toast.success(deleteWithStocks ? '已删除分组及组内自选' : '已删除分组');
    setDeleteTarget(null);
  };

  return (
    <>
      <Modal title="管理分组" onClose={onClose}>
        <div className="p-4 space-y-4">
          {/* 新建分组 */}
          <div className="flex gap-2">
            <Input
              type="text"
              value={newName}
              maxLength={MAX_NAME_LEN}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleCreate(); }}
              placeholder={`新分组名称（≤${MAX_NAME_LEN}字）`}
            />
            <button
              onClick={handleCreate}
              className="px-3 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition flex items-center gap-1 shrink-0"
            >
              <Plus className="w-4 h-4" />
              创建
            </button>
          </div>

          {/* 分组列表 */}
          <div className="space-y-2">
            {groups.length === 0 && (
              <p className="text-xs text-gray-400 text-center py-3">还没有分组，先在上方创建一个</p>
            )}
            {groups.map(g => {
              const isEditing = editingId === g.id;
              return (
                <div key={g.id} className="flex items-center gap-2 border border-gray-100 dark:border-gray-800 rounded-lg p-2.5">
                  {isEditing ? (
                    <Input
                      type="text"
                      value={editName}
                      maxLength={MAX_NAME_LEN}
                      autoFocus
                      onChange={e => setEditName(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') saveRename(g.id);
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                      className="py-1"
                    />
                  ) : (
                    <span className="flex-1 text-sm text-gray-800 dark:text-gray-200 truncate">{g.name}</span>
                  )}

                  <span className="text-xs text-gray-400 shrink-0">{countOf(g.id)} 只</span>

                  {isEditing ? (
                    <button
                      onClick={() => saveRename(g.id)}
                      className="p-1.5 text-green-600 hover:bg-green-50 dark:hover:bg-green-950 rounded-lg shrink-0"
                      title="保存"
                    >
                      <Check className="w-4 h-4" />
                    </button>
                  ) : (
                    <>
                      <button
                        onClick={() => startRename(g.id, g.name)}
                        className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950 rounded-lg shrink-0"
                        title="重命名"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => { setDeleteTarget({ id: g.id, name: g.name, count: countOf(g.id) }); setDeleteWithStocks(false); }}
                        className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950 rounded-lg shrink-0"
                        title="删除分组"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </Modal>

      {/* 删除分组确认弹窗 */}
      {deleteTarget && (
        <Modal title={`删除分组「${deleteTarget.name}」？`} onClose={() => setDeleteTarget(null)} variant="center" maxWidth="sm:max-w-sm">
          <div className="p-5 space-y-3">
            <p className="text-sm text-gray-500">共 {deleteTarget.count} 只标的</p>
            <button
              onClick={() => setDeleteWithStocks(false)}
              className={cn(
                'w-full flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm text-left transition',
                !deleteWithStocks
                  ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]'
                  : 'border-gray-200 dark:border-gray-700'
              )}
            >
              <span className={cn('w-3.5 h-3.5 rounded-full border shrink-0', !deleteWithStocks && 'border-[var(--color-accent)]')}>
                {!deleteWithStocks && <span className="block w-1.5 h-1.5 rounded-full bg-[var(--color-accent)] m-auto mt-[3px]" />}
              </span>
              <span>
                <span className="block font-medium text-gray-800 dark:text-gray-200">仅删分组，标的留自选</span>
              </span>
            </button>
            <button
              onClick={() => setDeleteWithStocks(true)}
              className={cn(
                'w-full flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm text-left transition',
                deleteWithStocks
                  ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]'
                  : 'border-gray-200 dark:border-gray-700'
              )}
            >
              <span className={cn('w-3.5 h-3.5 rounded-full border shrink-0', deleteWithStocks && 'border-[var(--color-accent)]')}>
                {deleteWithStocks && <span className="block w-1.5 h-1.5 rounded-full bg-[var(--color-accent)] m-auto mt-[3px]" />}
              </span>
              <span>
                <span className="block font-medium text-gray-800 dark:text-gray-200">连分组自选一起删</span>
                <span className="block text-xs text-gray-400 mt-0.5">其他分组也有的保留</span>
              </span>
            </button>
            <div className="flex gap-2 pt-1">
              <button
                onClick={() => setDeleteTarget(null)}
                className="flex-1 py-2 rounded-lg text-sm bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-700 transition"
              >
                取消
              </button>
              <button
                onClick={handleDelete}
                className="flex-1 py-2 rounded-lg text-sm font-medium bg-[var(--color-danger)] text-white hover:opacity-90 transition"
              >
                删除
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
