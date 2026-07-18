'use client';

import { useState } from 'react';
import { AiAnalysisRecord, useAiStore } from '@/store/ai-store';
import { cn } from '@/lib/utils';
import { ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

interface Props {
  history: AiAnalysisRecord[];
}

export function AnalysisHistory({ history }: Props) {
  const aiStore = useAiStore();
  const [showHistory, setShowHistory] = useState(false);
  const [expandedHistory, setExpandedHistory] = useState<Set<string>>(new Set());

  if (history.length === 0) return null;

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl p-4 shadow-sm">
      <button
        onClick={() => setShowHistory(!showHistory)}
        className="flex items-center gap-2 hover:bg-gray-50 dark:hover:bg-gray-800 rounded-lg p-1 -m-1 transition"
      >
        {showHistory ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
        <h3 className="font-semibold">历史分析 ({history.length})</h3>
      </button>
      {showHistory && (
        <>
          <div className="flex justify-end mb-2">
            <button
              onClick={() => { aiStore.clearHistory(); toast.success('已清空全部历史'); }}
              className="text-xs text-red-500 hover:text-red-600 px-2 py-1 hover:bg-red-50 dark:hover:bg-red-950 rounded transition"
            >
              清空全部
            </button>
          </div>
          <div className="space-y-2">
            {history.slice(0, 20).map(record => {
              const isExpanded = expandedHistory.has(record.id);
              return (
                <div key={record.id} className="border border-gray-100 dark:border-gray-800 rounded-lg">
                  <div className="p-3 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-800 rounded-lg transition cursor-pointer"
                    onClick={() => {
                      const next = new Set(expandedHistory);
                      if (isExpanded) next.delete(record.id);
                      else next.add(record.id);
                      setExpandedHistory(next);
                    }}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{record.stockName}</p>
                      <p className="text-xs text-gray-500">
                        {record.profileName} · {new Date(record.createdAt).toLocaleString('zh-CN')}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className={cn(
                        "text-xs px-2 py-0.5 rounded-full",
                        record.riskLevel.includes('高') ? "bg-red-100 text-red-600" :
                        record.riskLevel.includes('中') ? "bg-orange-100 text-orange-600" :
                        "bg-blue-100 text-blue-600"
                      )}>
                        {record.riskLevel}
                      </span>
                      <button
                        onClick={(e) => { e.stopPropagation(); aiStore.deleteHistory(record.id); }}
                        className="p-1 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950 rounded transition"
                        title="删除"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                      {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="px-3 pb-3 space-y-2 text-sm text-gray-600 dark:text-gray-400 border-t border-gray-50 dark:border-gray-800 pt-2">
                      <p>{record.analysis}</p>
                      {record.suggestion && (
                        <p className="text-purple-600">💡 {record.suggestion}</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
