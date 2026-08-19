'use client';

/**
 * 自选分组管理弹窗 — 新建 / 重命名 / 删除 / 拖拽排序分组。
 * 删除弹窗两选项：仅删分组（标的留自选）/ 连分组自选一起删（其他组也有的保留）。
 */

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Plus, Pencil, Trash2, Check, Menu } from 'lucide-react';
import { useStockStore } from '@/store';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';

const MAX_NAME_LEN = 12;

export function GroupManageModal({ onClose }: { onClose: () => void }) {
  const { groups, addGroup, renameGroup, deleteGroup, reorderGroups } = useStockStore();
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string; count: number } | null>(null);
  const [deleteWithStocks, setDeleteWithStocks] = useState(false);

  // 分组垂直拖拽排序（复用 watchlist 卡片拖拽模式；滚动容器是下方列表 listRef，不是 window）
  const listRef = useRef<HTMLDivElement | null>(null);
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const [dragInfo, setDragInfo] = useState<{ id: string; offsetY: number } | null>(null);
  const dragRef = useRef<{ id: string; startY: number; startScroll: number; lastOffset: number } | null>(null);
  const dragOrderRef = useRef<string[] | null>(null);
  const dragPosRef = useRef(0);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  const applyDrag = (clientY: number) => {
    const d = dragRef.current;
    const order = dragOrderRef.current;
    const container = listRef.current;
    if (!d || !order || !container) return;
    const from = order.indexOf(d.id);
    // 插入位 = 首张「中线在指针上方」行的槽位（换算成移除被拖行后的下标；都没越线=排末尾）
    let to = order.length - 1;
    for (let i = 0; i < order.length; i++) {
      if (order[i] === d.id) continue;
      const r = document.querySelector(`[data-group-id="${order[i]}"]`)?.getBoundingClientRect();
      if (r && clientY < r.top + r.height / 2) { to = i > from ? i - 1 : i; break; }
    }
    if (from >= 0 && to !== from) {
      const GAP = 8; // space-y-2
      const step = to > from ? 1 : -1;
      let shift = 0;
      for (let i = from + step; step > 0 ? i <= to : i >= to; i += step) {
        shift += step * (GAP + (document.querySelector(`[data-group-id="${order[i]}"]`)?.getBoundingClientRect().height ?? 0));
      }
      d.startY += shift;
      const next = [...order];
      next.splice(from, 1);
      next.splice(to, 0, d.id);
      dragOrderRef.current = next;
      setDragOrder(next);
    }
    // 容器自身滚动也要计入位移（边缘自动滚动时指针不动但内容在动）
    const offsetY = (clientY - d.startY) + (container.scrollTop - d.startScroll);
    if (offsetY !== d.lastOffset) {
      d.lastOffset = offsetY;
      setDragInfo({ id: d.id, offsetY });
    }
  };

  const handleGripDown = (e: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    dragCleanupRef.current?.();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 指针已失效时忽略 */ }
    const container = listRef.current;
    if (!container) return;
    dragRef.current = { id, startY: e.clientY, startScroll: container.scrollTop, lastOffset: 0 };
    dragPosRef.current = e.clientY;
    dragOrderRef.current = groups.map(g => g.id);
    setDragOrder(dragOrderRef.current);
    setDragInfo({ id, offsetY: 0 });

    let raf = 0;
    const tick = () => {
      if (!dragRef.current) return;
      const y = dragPosRef.current;
      const rect = container.getBoundingClientRect();
      const EDGE = 48;
      if (y < rect.top + EDGE) container.scrollBy(0, -(rect.top + EDGE - y) / 6);
      else if (y > rect.bottom - EDGE) container.scrollBy(0, (y - (rect.bottom - EDGE)) / 6);
      applyDrag(y);
      raf = requestAnimationFrame(tick);
    };
    const onMove = (ev: PointerEvent) => { dragPosRef.current = ev.clientY; };
    const onUp = () => {
      cleanup();
      if (dragOrderRef.current) reorderGroups(dragOrderRef.current);
      dragRef.current = null;
      dragOrderRef.current = null;
      setDragOrder(null);
      setDragInfo(null);
    };
    const cleanup = () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      dragCleanupRef.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    dragCleanupRef.current = cleanup;
    raf = requestAnimationFrame(tick);
  };

  // 卸载兜底：清掉 window 监听与 rAF
  useEffect(() => () => dragCleanupRef.current?.(), []);

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

          {/* 分组列表：垂直拖拽排序（复用 watchlist 卡片拖拽模式，边缘自动滚动适配本容器） */}
          <div ref={listRef} className="space-y-2 max-h-[50vh] overflow-y-auto">
            {groups.length === 0 && (
              <p className="text-xs text-gray-400 text-center py-3">还没有分组，先在上方创建一个</p>
            )}
            {(dragOrder ?? groups.map(g => g.id)).map(id => {
              const g = groups.find(x => x.id === id);
              if (!g) return null;
              const isEditing = editingId === g.id;
              const isDragging = dragInfo?.id === g.id;
              return (
                <div
                  key={g.id}
                  data-group-id={g.id}
                  className={cn(
                    'flex items-center gap-2 border border-gray-100 dark:border-gray-800 rounded-lg p-2.5 select-none',
                    isDragging && 'relative z-10 shadow-lg opacity-90'
                  )}
                  style={isDragging ? { transform: `translateY(${dragInfo.offsetY}px)`, pointerEvents: 'none' } : undefined}
                >
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
                  {/* 拖拽把手（与自选页一致：三横线、最右） */}
                  <button
                    onPointerDown={(e) => handleGripDown(e, g.id)}
                    onTouchStart={(e) => e.stopPropagation()}
                    title="按住拖动排序"
                    className="p-2 -mr-2 shrink-0 text-gray-300 dark:text-gray-600 hover:text-gray-500 cursor-grab active:cursor-grabbing touch-none"
                  >
                    <Menu className="w-4 h-4" />
                  </button>
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
