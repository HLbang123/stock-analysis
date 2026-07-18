'use client';

import { useAiStore } from '@/store/ai-store';
import { AiProfile } from '@/store/ai-store';
import { cn } from '@/lib/utils';
import { X, Plus, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

interface Props {
  onClose: () => void;
  onAdd: () => void;
  onEdit: (profile: AiProfile) => void;
}

export function ProfileSettingsModal({ onClose, onAdd, onEdit }: Props) {
  const aiStore = useAiStore();
  const { profiles, currentProfileId } = aiStore;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-lg max-h-[85vh] overflow-auto">
        <div className="sticky top-0 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 p-4 flex items-center justify-between">
          <h2 className="font-semibold text-lg">API 配置管理</h2>
          <button onClick={onClose} className="p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          {profiles.map(p => (
            <div
              key={p.id}
              className={cn(
                "p-3 rounded-xl border transition",
                p.id === currentProfileId
                  ? "border-blue-500 bg-blue-50 dark:bg-blue-950"
                  : "border-gray-200 dark:border-gray-700"
              )}
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-sm">{p.name}</p>
                  <p className="text-xs text-gray-500">{p.model}</p>
                  <p className="text-xs text-gray-400 truncate max-w-[200px]">{p.baseUrl}</p>
                </div>
                <div className="flex items-center gap-1">
                  {p.id !== currentProfileId && (
                    <button
                      onClick={() => { aiStore.setCurrentProfile(p.id); onClose(); }}
                      className="p-1.5 text-blue-600 hover:bg-blue-100 rounded-lg transition text-xs"
                    >
                      使用
                    </button>
                  )}
                  <button
                    onClick={() => onEdit(p)}
                    className="p-1.5 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition"
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => {
                      aiStore.deleteProfile(p.id);
                      toast.success('已删除');
                    }}
                    className="p-1.5 text-red-500 hover:bg-red-50 rounded-lg transition"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}

          <button
            onClick={onAdd}
            className="w-full py-3 border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-xl text-gray-500 hover:border-blue-400 hover:text-blue-500 transition flex items-center justify-center gap-2"
          >
            <Plus className="w-4 h-4" />
            添加API配置
          </button>
        </div>
      </div>
    </div>
  );
}
