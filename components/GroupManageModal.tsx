'use client';

/**
 * 自选分组管理弹窗 — 新建 / 重命名 / 删除分组。
 * 删除两步确认（3 秒未点自动恢复）；删除后组内自选变为未分组。
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
  const { groups, watchlist, addGroup, renameGroup, deleteGroup } = useStockStore();
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const countOf = (id: string) => watchlist.filter(s => s.groupId === id).length;

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

  const handleDelete = (id: string, name: string) => {
    if (confirmDeleteId === id) {
      deleteGroup(id);
      setConfirmDeleteId(null);
      toast.success(`已删除「${name}」，其中自选已变为未分组`);
    } else {
      setConfirmDeleteId(id);
      setTimeout(() => setConfirmDeleteId(c => (c === id ? null : c)), 3000);
    }
  };

  return (
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
              const isConfirming = confirmDeleteId === g.id;
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
                        onClick={() => handleDelete(g.id, g.name)}
                        className={cn(
                          'p-1.5 rounded-lg shrink-0 transition',
                          isConfirming
                            ? 'bg-red-600 text-white px-2 text-xs'
                            : 'text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950',
                        )}
                        title={isConfirming ? '再次点击确认删除' : '删除分组'}
                      >
                        {isConfirming ? '确认删除' : <Trash2 className="w-4 h-4" />}
                      </button>
                    </>
                  )}
                </div>
              );
            })}
          </div>

          <p className="text-xs text-gray-400">
            删除分组后，组内自选将变为未分组，仍可在「全部」中看到。
          </p>
      </div>
    </Modal>
  );
}
