'use client';

import { useState, useEffect } from 'react';
import { AiAnalysisRecord, useAiStore } from '@/store/ai-store';
import { cn } from '@/lib/utils';
import { ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { TermTooltip } from '@/components/ui/TermTooltip';

interface Props {
  history: AiAnalysisRecord[];
}

interface EvalItem { nDays: number; returnPct: number | null; }
interface RecordRow { id: string; action: string; entryPrice: number; evals: EvalItem[]; }

interface StatGroup {
  action: string;
  byN: { nDays: number; count: number; wins: number; winRate: number; avgReturn: number }[];
}

/** 胜负判定：买入看涨、卖出看跌、持有看震荡 */
function isWin(action: string, returnPct: number): boolean {
  if (action === '买入') return returnPct > 0;
  if (action === '卖出') return returnPct < 0;
  return Math.abs(returnPct) < 5;
}

export function AnalysisHistory({ history }: Props) {
  const aiStore = useAiStore();
  const [showHistory, setShowHistory] = useState(false);
  const [expandedHistory, setExpandedHistory] = useState<Set<string>>(new Set());
  const [evalMap, setEvalMap] = useState<Record<string, RecordRow[]>>({});
  const [stats, setStats] = useState<StatGroup[] | null>(null);

  // 顶部胜率面板（全局）
  useEffect(() => {
    if (!showHistory) return;
    fetch('/api/ai/deep-eval/stats').then(r => r.ok ? r.json() : null).then(d => {
      if (d?.stats) setStats(d.stats);
    }).catch(() => {});
  }, [showHistory]);

  // 展开某条记录时拉取该股该日回测（失败也置空，避免卡在"加载中"）
  const loadEval = async (record: AiAnalysisRecord) => {
    if (!record.entryDate || !record.stockCode) return;
    const key = `${record.stockCode}|${record.entryDate}`;
    if (evalMap[key]) return;
    try {
      const res = await fetch(`/api/ai/deep-eval?stockCode=${record.stockCode}&entryDate=${record.entryDate}`);
      const data = res.ok ? await res.json() : null;
      setEvalMap(prev => ({ ...prev, [key]: data?.records || [] }));
    } catch {
      setEvalMap(prev => ({ ...prev, [key]: [] }));
    }
  };

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
          {/* 全局胜率面板 */}
          {stats && stats.length > 0 && (
            <div className="mt-3 p-3 rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700">
              <p className="text-xs font-medium text-gray-500 mb-2">
                <TermTooltip term="回测胜率" explain="深度分析建议后 T+N 个交易日的实际收益验证。买入看涨、卖出看跌、持有看震荡。全局匿名聚合，跨用户共享。" />（全局）
              </p>
              <div className="space-y-1.5">
                {stats.map(g => (
                  <div key={g.action} className="flex items-center gap-2 text-xs">
                    <span className={cn(
                      "w-12 shrink-0 font-medium",
                      g.action === '买入' ? "text-red-600" : g.action === '卖出' ? "text-green-600" : "text-gray-500"
                    )}>{g.action}</span>
                    <div className="flex-1 flex flex-wrap gap-3">
                      {g.byN.sort((a, b) => a.nDays - b.nDays).map(s => (
                        <span key={s.nDays} className="text-gray-600 dark:text-gray-400">
                          T+{s.nDays}: <span className={cn("font-semibold", s.winRate >= 50 ? "text-green-600" : "text-red-600")}>{s.winRate}%</span>
                          <span className="text-gray-400"> ({s.count}样本, 均{s.avgReturn > 0 ? '+' : ''}{s.avgReturn}%)</span>
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex justify-end mb-2 mt-2">
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
              const evalKey = `${record.stockCode}|${record.entryDate}`;
              const evals = record.entryDate ? evalMap[evalKey] : undefined;
              return (
                <div key={record.id} className="border border-gray-100 dark:border-gray-800 rounded-lg">
                  <div className="p-3 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-800 rounded-lg transition cursor-pointer"
                    onClick={() => {
                      const next = new Set(expandedHistory);
                      if (isExpanded) next.delete(record.id);
                      else { next.add(record.id); loadEval(record); }
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
                      {/* 回测结果 */}
                      {record.entryDate && (
                        <div className="text-xs">
                          <p className="text-gray-500 mb-1">回测验证（入场日 {record.entryDate}）：</p>
                          {evals === undefined ? (
                            <p className="text-gray-400">加载中...</p>
                          ) : evals.length === 0 ? (
                            <p className="text-gray-400">暂无回测数据（可能数据未到或未回填）</p>
                          ) : (
                            <div className="flex flex-wrap gap-3">
                              {evals.flatMap(r => r.evals.filter(e => e.returnPct != null).map(e => {
                                const win = isWin(r.action, e.returnPct!);
                                return (
                                  <span key={`${r.id}|${e.nDays}`} className={cn("font-medium", win ? "text-green-600" : "text-red-600")}>
                                    T+{e.nDays}: {e.returnPct! > 0 ? '+' : ''}{e.returnPct!.toFixed(1)}% {win ? '✓' : '✗'}
                                  </span>
                                );
                              }))}
                            </div>
                          )}
                        </div>
                      )}
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
