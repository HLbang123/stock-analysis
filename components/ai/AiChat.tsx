'use client';

import { useState, useRef, useEffect } from 'react';
import { AiProfile, useAiStore, type ChatMessage } from '@/store/ai-store';
import { Stock } from '@/types';
import { getRealtimeQuote, getKLineSina } from '@/services/stockApi';
import { fetchTushareData, formatTopListForChat } from '@/services/tushareData';
import { cn } from '@/lib/utils';
import { Send, Trash, X, Plus } from 'lucide-react';
import { ReasoningPanel } from '@/components/ai/ReasoningPanel';

interface QuickResult {
  finalBuy: number;
  finalSell: number;
  buyAdjust: number;
  analysis: string;
  buyReason: string;
  sellReason: string;
}

interface DeepStructured {
  action: string;
  oneLiner?: string;
  riskLevel: string;
  confidence: number;
  position: number;
  targetLow: number;
  targetHigh: number;
  stopLoss: number;
  keyPoints?: string[];
  reasoning?: string;
}

interface Props {
  currentProfile: AiProfile;
  selectedCode: string;
  watchlist: Stock[];
  result: QuickResult | null;
  deepStructured: DeepStructured | null;
}

export function AiChat({ currentProfile, selectedCode, watchlist, result, deepStructured }: Props) {
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(() => useAiStore.getState().chatMessages ?? []);
  const [chatInput, setChatInput] = useState('');
  const [isChatStreaming, setIsChatStreaming] = useState(false);
  const [attachStockContext, setAttachStockContext] = useState(true);
  const [attachAnalysisResult, setAttachAnalysisResult] = useState(true);
  // 对比标的列表（平等对比，最多 5 只）。selectedCode 作为主标的同步进首位。
  const [compareCodes, setCompareCodes] = useState<string[]>(() => {
    const stored = useAiStore.getState().compareCodes;
    return stored?.length ? stored : (selectedCode ? [selectedCode] : []);
  });
  const [pendingAdd, setPendingAdd] = useState('');
  const chatAbortRef = useRef<AbortController | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatSyncRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  // 上方主标的变化时，确保它在对比列表里（首位），便于带上其分析结论
  useEffect(() => {
    if (!selectedCode) return;
    setCompareCodes(prev => (prev.includes(selectedCode) ? prev : [selectedCode, ...prev].slice(0, 5)));
  }, [selectedCode]);

  // 对话 debounce 同步到 store：流式期间不断重置，停止后 300ms 写一次，避免每 token 写 localStorage
  useEffect(() => {
    if (chatSyncRef.current) clearTimeout(chatSyncRef.current);
    chatSyncRef.current = setTimeout(() => {
      useAiStore.getState().setChatMessages(chatMessages);
    }, 300);
    return () => { if (chatSyncRef.current) clearTimeout(chatSyncRef.current); };
  }, [chatMessages]);

  // 对比列表非流式，直接同步
  useEffect(() => {
    useAiStore.getState().setCompareCodes(compareCodes);
  }, [compareCodes]);

  const addCompareCode = (code: string) => {
    if (!code) return;
    setCompareCodes(prev => {
      if (prev.includes(code)) return prev;
      if (prev.length >= 5) return prev; // 上限 5 只，调用方提示
      return [...prev, code];
    });
  };

  const removeCompareCode = (code: string) => {
    setCompareCodes(prev => prev.filter(c => c !== code));
  };

  const cancelChat = () => {
    if (chatAbortRef.current) {
      chatAbortRef.current.abort();
      chatAbortRef.current = null;
    }
    setIsChatStreaming(false);
  };

  // 开新对话：清空当前对话（保留对比列表），同步到 store
  const newChat = () => {
    setChatMessages([]);
    useAiStore.getState().clearChatMessages();
  };

  /** 拼单只标的的数据块（实时行情 + 近20日K线 + 基本面 + 龙虎榜）。取数失败返回 null。
   *  分析结论仅附给主标的 selectedCode（对比股没有分析结果）。 */
  const buildStockBlock = async (code: string): Promise<string | null> => {
    const stock = watchlist.find(s => s.code === code);
    const [quote, kLines, tushare] = await Promise.all([
      getRealtimeQuote(code),
      getKLineSina(code, 240, 60),
      fetchTushareData(code).catch(() => null),
    ]);
    if (!quote) return null;
    const klineSummary = kLines.slice(-20).map(k =>
      `${k.date} ${k.open} ${k.high} ${k.low} ${k.close} ${k.volume}`
    ).join('\n');
    let block = `当前标的：${stock?.name || quote.name} (${code})\n实时行情：${JSON.stringify({ price: quote.price, changePercent: quote.changePercent.toFixed(2) + '%', high: quote.high, low: quote.low, open: quote.open, volume: quote.volume })}\n近20日K线：\n${klineSummary}`;

    if (tushare) {
      const parts: string[] = [];
      const db = tushare.dailyBasic?.[0];
      const fi = tushare.finaIndicator?.[0];
      const hk = tushare.hkHold?.[0];
      if (db?.pe_ttm !== undefined) parts.push(`PE ${db.pe_ttm.toFixed(1)}`);
      if (db?.pb !== undefined) parts.push(`PB ${db.pb.toFixed(2)}`);
      if (fi?.roe !== undefined) parts.push(`ROE ${fi.roe.toFixed(1)}%`);
      if (fi?.or_yoy !== undefined) parts.push(`营收${fi.or_yoy > 0 ? '+' : ''}${fi.or_yoy.toFixed(1)}%`);
      if (db?.total_mv !== undefined) {
        const yi = db.total_mv / 10000;
        parts.push(`市值${yi >= 1 ? yi.toFixed(1) + '亿' : db.total_mv.toFixed(0) + '万'}`);
      }
      if (hk?.hold_ratio !== undefined) parts.push(`北向${hk.hold_ratio.toFixed(2)}%`);
      if (parts.length > 0) block += `\n基本面：${parts.join(' | ')}`;
      const tlLine = formatTopListForChat(tushare);
      if (tlLine) block += `\n${tlLine}`;
    }

    if (code === selectedCode && attachAnalysisResult) {
      if (result) {
        block += `\n\n最新波段评分：买点 ${result.finalBuy} 分${result.buyAdjust ? `（LLM微调${result.buyAdjust > 0 ? '+' : ''}${result.buyAdjust}）` : ''}，卖点 ${result.finalSell} 分`;
        if (result.analysis) block += `\n${result.analysis}`;
      }
      if (deepStructured?.action) {
        block += `\n\n最新深度分析结论：${deepStructured.action} | 风险${deepStructured.riskLevel} | 信心${deepStructured.confidence}% | 仓位${Number.isFinite(deepStructured.position) ? deepStructured.position.toFixed(0) + '%' : '--'} | 目标${Number.isFinite(deepStructured.targetLow) ? deepStructured.targetLow.toFixed(2) : '--'}-${Number.isFinite(deepStructured.targetHigh) ? deepStructured.targetHigh.toFixed(2) : '--'} | 止损${Number.isFinite(deepStructured.stopLoss) ? deepStructured.stopLoss.toFixed(2) : '--'}`;
        if (deepStructured.keyPoints && deepStructured.keyPoints.length > 0) {
          block += `\n关键要点：${deepStructured.keyPoints.join('；')}`;
        }
        if (deepStructured.reasoning) {
          block += `\n决策理由：${deepStructured.reasoning.slice(0, 300)}`;
        }
      }
    }
    return block;
  };

  const sendMessage = async (text?: string) => {
    const msg = (text || chatInput).trim();
    if (!msg || isChatStreaming) return;

    setChatInput('');
    const userMsg = { role: 'user' as const, content: msg };
    setChatMessages(prev => [...prev, userMsg]);
    setIsChatStreaming(true);

    const abortController = new AbortController();
    chatAbortRef.current = abortController;

    try {
      let stockContext = '';
      if (attachStockContext && compareCodes.length > 0) {
        const blocks = await Promise.all(compareCodes.map(code => buildStockBlock(code)));
        stockContext = compareCodes
          .map((code, i) => {
            if (!blocks[i]) return null;
            const name = watchlist.find(s => s.code === code)?.name || code;
            return `=== 对比标的 ${i + 1}/${compareCodes.length}：${name} (${code}) ===\n${blocks[i]}`;
          })
          .filter(Boolean)
          .join('\n\n');
      }

      const recentMessages = chatMessages.slice(-20).map(m => ({ role: m.role, content: m.content }));
      const allMessages = [...recentMessages, { role: 'user', content: msg }];

      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: allMessages,
          stockContext: stockContext || undefined,
          baseUrl: currentProfile.baseUrl,
          apiKey: currentProfile.apiKey,
          model: currentProfile.model,
        }),
        signal: abortController.signal,
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(errData.error || '请求失败');
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = '';
      let aiContent = '';
      let aiReasoning = '';

      setChatMessages(prev => [...prev, { role: 'assistant', content: '' }]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') continue;

          try {
            const chunk = JSON.parse(data);
            if (typeof chunk === 'string') {
              aiContent += chunk;
              setChatMessages(prev => {
                const updated = [...prev];
                updated[updated.length - 1] = { role: 'assistant', content: aiContent, reasoning: aiReasoning || undefined };
                return updated;
              });
            } else if (chunk && chunk.reasoning) {
              aiReasoning += chunk.reasoning;
              setChatMessages(prev => {
                const updated = [...prev];
                updated[updated.length - 1] = { role: 'assistant', content: aiContent, reasoning: aiReasoning };
                return updated;
              });
            }
          } catch {}
        }
      }
    } catch (err) {
      const e = err as Error;
      if (e.name !== 'AbortError') {
        setChatMessages(prev => [...prev, { role: 'assistant', content: `❌ ${e.message}` }]);
      }
    } finally {
      setIsChatStreaming(false);
      chatAbortRef.current = null;
    }
  };

  const handleChatKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl p-4 shadow-sm mb-6">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-sm flex items-center gap-2">
          <Send className="w-4 h-4 text-blue-500" />
          AI 对话
        </h3>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={attachStockContext}
              onChange={(e) => setAttachStockContext(e.target.checked)}
              className="w-3.5 h-3.5 rounded accent-blue-600"
            />
            <span className="text-xs text-gray-500">
              {compareCodes.length > 0 ? `附上 ${compareCodes.length} 只标的数据` : '附上标的数据'}
            </span>
          </label>
          {(result || deepStructured?.action) && (
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={attachAnalysisResult}
                onChange={(e) => setAttachAnalysisResult(e.target.checked)}
                className="w-3.5 h-3.5 rounded accent-blue-600"
              />
              <span className="text-xs text-gray-500">附带分析结论</span>
            </label>
          )}
          {chatMessages.length > 0 && (
            <button
              onClick={newChat}
              className="flex items-center gap-1 px-2 py-1 text-xs text-gray-400 hover:text-red-500 transition"
              title="开新对话"
            >
              <Trash className="w-3.5 h-3.5" />
              新对话
            </button>
          )}
        </div>
      </div>

      {/* 对比标的选择（最多 5 只，平等对比） */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <select
          value={pendingAdd}
          onChange={(e) => setPendingAdd(e.target.value)}
          className="p-1.5 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 max-w-[180px]"
        >
          <option value="">-- 添加自选 --</option>
          {watchlist.filter(s => !compareCodes.includes(s.code)).map(stock => (
            <option key={stock.code} value={stock.code}>
              {stock.name} ({stock.code})
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => {
            if (compareCodes.length >= 5) {
              alert('最多对比 5 只标的');
              return;
            }
            addCompareCode(pendingAdd);
            setPendingAdd('');
          }}
          className="p-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition disabled:opacity-40"
          disabled={!pendingAdd || compareCodes.length >= 5}
          title="添加到对比"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
        {compareCodes.length === 0 ? (
          <span className="text-xs text-gray-400">未选择对比标的（可只发纯问答）</span>
        ) : (
          compareCodes.map(code => {
            const name = watchlist.find(s => s.code === code)?.name || code;
            return (
              <span
                key={code}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 text-xs"
              >
                {name} ({code})
                <button
                  type="button"
                  onClick={() => removeCompareCode(code)}
                  className="hover:text-red-500 transition"
                  title="移除"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            );
          })
        )}
      </div>

      {(chatMessages.length > 0 || isChatStreaming) && (
        <div className="max-h-80 overflow-y-auto space-y-3 mb-3">
          {chatMessages.map((msg, i) => (
            <div
              key={i}
              className={cn("flex", msg.role === 'user' ? "justify-end" : "justify-start")}
            >
              <div className={cn(
                "max-w-[85%] rounded-xl px-3.5 py-2.5 text-sm",
                msg.role === 'user'
                  ? "bg-blue-600 text-white rounded-br-md"
                  : "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-bl-md"
              )}>
                <div className="whitespace-pre-wrap break-words leading-relaxed">
                  {msg.content}
                  {isChatStreaming && i === chatMessages.length - 1 && msg.role === 'assistant' && (
                    <span className="text-blue-500 animate-pulse text-lg font-bold">···</span>
                  )}
                </div>
                {msg.role === 'assistant' && msg.reasoning && (
                  <ReasoningPanel
                    reasoning={msg.reasoning}
                    isStreaming={isChatStreaming && i === chatMessages.length - 1}
                    variant="light"
                  />
                )}
              </div>
            </div>
          ))}
          <div ref={chatEndRef} />
        </div>
      )}

      <div className="flex gap-2">
        <input
          id="chat-input"
          type="text"
          value={chatInput}
          onChange={(e) => setChatInput(e.target.value)}
          onKeyDown={handleChatKeyDown}
          placeholder="输入问题，Enter 发送..."
          disabled={isChatStreaming}
          className="flex-1 px-3.5 py-2.5 border border-gray-200 dark:border-gray-700 rounded-xl bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
        />
        {isChatStreaming ? (
          <button
            onClick={cancelChat}
            className="px-4 py-2.5 bg-red-500 text-white rounded-xl text-sm font-medium hover:bg-red-600 transition"
          >
            停止
          </button>
        ) : (
          <button
            onClick={() => sendMessage()}
            disabled={!chatInput.trim()}
            className="px-4 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-medium hover:bg-blue-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Send className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}
