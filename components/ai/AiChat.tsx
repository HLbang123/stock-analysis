'use client';

import { useState, useRef, useEffect } from 'react';
import { AiProfile } from '@/store/ai-store';
import { Stock } from '@/types';
import { getRealtimeQuote, getKLineSina } from '@/services/stockApi';
import { fetchTushareData, formatTopListForChat } from '@/services/tushareData';
import { cn } from '@/lib/utils';
import { Send, Trash } from 'lucide-react';

interface QuickResult {
  riskLevel: string;
  analysis: string;
  supportPrice: string;
  resistancePrice: string;
}

interface DeepStructured {
  action: string;
  riskLevel: string;
  confidence: number;
  position: string;
  targetLow: string;
  targetHigh: string;
  stopLoss: string;
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
  const [chatMessages, setChatMessages] = useState<{ role: 'user' | 'assistant'; content: string }[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [isChatStreaming, setIsChatStreaming] = useState(false);
  const [attachStockContext, setAttachStockContext] = useState(true);
  const [attachAnalysisResult, setAttachAnalysisResult] = useState(true);
  const chatAbortRef = useRef<AbortController | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  const cancelChat = () => {
    if (chatAbortRef.current) {
      chatAbortRef.current.abort();
      chatAbortRef.current = null;
    }
    setIsChatStreaming(false);
  };

  const clearChat = () => setChatMessages([]);

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
      if (attachStockContext && selectedCode) {
        const stock = watchlist.find(s => s.code === selectedCode);
        const [quote, kLines, tushare] = await Promise.all([
          getRealtimeQuote(selectedCode),
          getKLineSina(selectedCode, 240, 60),
          fetchTushareData(selectedCode).catch(() => null),
        ]);
        if (quote) {
          const klineSummary = kLines.slice(-20).map(k =>
            `${k.date} ${k.open} ${k.high} ${k.low} ${k.close} ${k.volume}`
          ).join('\n');
          stockContext = `当前股票：${stock?.name || quote.name} (${selectedCode})\n实时行情：${JSON.stringify({ price: quote.price, changePercent: quote.changePercent.toFixed(2) + '%', high: quote.high, low: quote.low, open: quote.open, volume: quote.volume })}\n近20日K线：\n${klineSummary}`;

          // Tushare 基本面速览（一行）
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
            if (parts.length > 0) {
              stockContext += `\n基本面：${parts.join(' | ')}`;
            }
            // 龙虎榜速览
            const tlLine = formatTopListForChat(tushare);
            if (tlLine) stockContext += `\n${tlLine}`;
          }

          if (attachAnalysisResult) {
            if (result) {
              stockContext += `\n\n最新心姐分析结论：风险${result.riskLevel}，支撑${result.supportPrice}，压力${result.resistancePrice}\n${result.analysis}`;
            }
            if (deepStructured?.action) {
              stockContext += `\n\n最新深度分析结论：${deepStructured.action} | 风险${deepStructured.riskLevel} | 信心${deepStructured.confidence}% | 仓位${deepStructured.position} | 目标${deepStructured.targetLow}-${deepStructured.targetHigh} | 止损${deepStructured.stopLoss}`;
              if (deepStructured.keyPoints && deepStructured.keyPoints.length > 0) {
                stockContext += `\n关键要点：${deepStructured.keyPoints.join('；')}`;
              }
              if (deepStructured.reasoning) {
                stockContext += `\n决策理由：${deepStructured.reasoning.slice(0, 300)}`;
              }
            }
          }
        }
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
                updated[updated.length - 1] = { role: 'assistant', content: aiContent };
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
              {selectedCode ? `附上 ${watchlist.find(s => s.code === selectedCode)?.name || selectedCode} 数据` : '附上股票数据'}
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
              onClick={clearChat}
              className="p-1 text-gray-400 hover:text-red-500 transition"
              title="清空对话"
            >
              <Trash className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
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
