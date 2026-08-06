'use client';

import { useState, useRef, useEffect } from 'react';
import { AiProfile, useAiStore, type ChatMessage } from '@/store/ai-store';
import { Stock } from '@/types';
import { getRealtimeQuote, getKLineSina } from '@/services/stockApi';
import { fetchTushareData, formatTopListForChat } from '@/services/tushareData';
import { cn } from '@/lib/utils';
import { Send, Trash, X, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { ReasoningPanel } from '@/components/ai/ReasoningPanel';
import { Input, Select } from '@/components/ui/input';
import { streamChatDirectChat } from '@/services/chat/browser-chat';
import { isDirectConnectionError } from '@/services/llm/browser-client';
import type { TScorePanelResult } from '@/components/ai/TScorePanel';
import type { DeepStructured } from '@/services/deep-analysis/engine';

interface Props {
  currentProfile: AiProfile;
  selectedCode: string;
  watchlist: Stock[];
  result: TScorePanelResult | null;
  deepStructured: DeepStructured | null;
}

/** 降级路径：服务器中转 SSE（直连不可达时的兜底，原实现保留） */
async function chatViaServer(
  messages: { role: string; content: string }[],
  stockContext: string,
  cfg: { baseUrl: string; apiKey?: string; model: string },
  signal: AbortSignal,
  onDelta: (d: { content?: string; reasoning?: string }) => void,
): Promise<void> {
  const res = await fetch('/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages,
      stockContext: stockContext || undefined,
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
    }),
    signal,
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(errData.error || '请求失败');
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';

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
          onDelta({ content: chunk });
        } else if (chunk && chunk.reasoning) {
          onDelta({ reasoning: chunk.reasoning });
        }
      } catch {}
    }
  }
}

export function AiChat({ currentProfile, selectedCode, watchlist, result, deepStructured }: Props) {
  // chat 状态以 store 为单一事实源（切路由恢复）；本地只留输入框/流式开关等瞬态
  const chatMessages = useAiStore(s => s.chatMessages);
  const setChatMessages = useAiStore(s => s.setChatMessages);
  const compareCodes = useAiStore(s => s.compareCodes);
  const setCompareCodes = useAiStore(s => s.setCompareCodes);
  const [chatInput, setChatInput] = useState('');
  const [isChatStreaming, setIsChatStreaming] = useState(false);
  const [attachStockContext, setAttachStockContext] = useState(true);
  const [attachAnalysisResult, setAttachAnalysisResult] = useState(true);
  const [pendingAdd, setPendingAdd] = useState('');
  const chatAbortRef = useRef<AbortController | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  // 流式回复本地累积：每 token 只 set 本地 state 触发渲染，不写 store（避免每 token 写 localStorage）；
  // 消息结束/取消/报错时才一次性并入 store，store 仍是跨路由恢复的事实源
  const [streamingMsg, setStreamingMsg] = useState<{ content: string; reasoning?: string } | null>(null);
  const streamBufRef = useRef<{ content: string; reasoning: string }>({ content: '', reasoning: '' });

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages, streamingMsg]);

  // 主标的固定首位（随上方选择自动切换，不累积）；compareCodes 只存用户手动添加的对比标的
  const effectiveCodes = selectedCode
    ? [selectedCode, ...compareCodes.filter(c => c !== selectedCode)].slice(0, 5)
    : compareCodes.slice(0, 5);

  const addCompareCode = (code: string) => {
    if (!code || effectiveCodes.includes(code) || effectiveCodes.length >= 5) return;
    setCompareCodes(prev => [...prev, code]);
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

  /** 把本地累积的流式回复一次性并入 store（结束/取消/报错时调用） */
  const flushStreamingMsg = () => {
    const buf = streamBufRef.current;
    if (buf.content || buf.reasoning) {
      setChatMessages(prev => [...prev, { role: 'assistant', content: buf.content, reasoning: buf.reasoning || undefined }]);
    }
    streamBufRef.current = { content: '', reasoning: '' };
    setStreamingMsg(null);
  };

  // 开新对话：清空当前对话（保留对比列表）
  const newChat = () => {
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
    streamBufRef.current = { content: '', reasoning: '' };
    setStreamingMsg({ content: '', reasoning: '' });

    const abortController = new AbortController();
    chatAbortRef.current = abortController;

    try {
      let stockContext = '';
      if (attachStockContext && effectiveCodes.length > 0) {
        const blocks = await Promise.all(effectiveCodes.map(code => buildStockBlock(code)));
        stockContext = effectiveCodes
          .map((code, i) => {
            if (!blocks[i]) return null;
            const name = watchlist.find(s => s.code === code)?.name || code;
            return `=== 对比标的 ${i + 1}/${effectiveCodes.length}：${name} (${code}) ===\n${blocks[i]}`;
          })
          .filter(Boolean)
          .join('\n\n');
      }

      const recentMessages = chatMessages.slice(-20).map(m => ({ role: m.role, content: m.content }));
      const allMessages = [...recentMessages, { role: 'user', content: msg }];
      const cfg = { baseUrl: currentProfile.baseUrl, apiKey: currentProfile.apiKey, model: currentProfile.model };

      // 直连 LLM：3 轮工具调用 + 流式输出（浏览器直发 provider，不走服务器中转）
      let aiContent = '';
      let aiReasoning = '';
      const appendDelta = (d: { content?: string; reasoning?: string }) => {
        if (d.content) {
          aiContent += d.content;
          streamBufRef.current = { content: aiContent, reasoning: aiReasoning };
          setStreamingMsg({ content: aiContent, reasoning: aiReasoning || undefined });
        }
        if (d.reasoning) {
          aiReasoning += d.reasoning;
          streamBufRef.current = { content: aiContent, reasoning: aiReasoning };
          setStreamingMsg({ content: aiContent, reasoning: aiReasoning });
        }
      };

      try {
        await streamChatDirectChat({
          messages: allMessages,
          stockContext: stockContext || undefined,
          cfg,
          signal: abortController.signal,
          onDelta: appendDelta,
        });
        flushStreamingMsg();
      } catch (err) {
        const e = err as Error;
        // 连接层失败（CORS/TypeError/超时）→ 降级服务器中转
        if (isDirectConnectionError(e)) {
          console.warn('[AiChat] 直连失败，降级服务器中转:', e.message);
          try {
            await chatViaServer(allMessages, stockContext, cfg, abortController.signal, appendDelta);
            flushStreamingMsg();
          } catch (err2) {
            const e2 = err2 as Error;
            flushStreamingMsg();
            if (e2.name !== 'AbortError') {
              setChatMessages(prev => [...prev, { role: 'assistant', content: `❌ ${e2.message}` }]);
            }
          }
        } else {
          flushStreamingMsg();
          if (e.name !== 'AbortError') {
            setChatMessages(prev => [...prev, { role: 'assistant', content: `❌ ${e.message}` }]);
          }
        }
      }
    } catch (err) {
      // 前置阶段（股票上下文拼装）失败等未处理错误
      const e = err as Error;
      flushStreamingMsg();
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
              {effectiveCodes.length > 0 ? `附上 ${effectiveCodes.length} 只标的数据` : '附上标的数据'}
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

      {/* 对比标的：主标的随上方切换自动更新，其余手动添加（合计最多 5 只） */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <Select
          value={pendingAdd}
          onChange={(e) => setPendingAdd(e.target.value)}
          block={false}
          className="p-1.5 text-xs max-w-[180px] w-auto"
        >
          <option value="">-- 添加自选 --</option>
          {watchlist.filter(s => !effectiveCodes.includes(s.code)).map(stock => (
            <option key={stock.code} value={stock.code}>
              {stock.name} ({stock.code})
            </option>
          ))}
        </Select>
        <button
          type="button"
          onClick={() => {
            if (effectiveCodes.length >= 5) {
              toast.warning('最多对比 5 只标的');
              return;
            }
            addCompareCode(pendingAdd);
            setPendingAdd('');
          }}
          className="p-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition disabled:opacity-40"
          disabled={!pendingAdd || effectiveCodes.length >= 5}
          title="添加到对比"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
        {effectiveCodes.length === 0 ? (
          <span className="text-xs text-gray-400">未选择对比标的（可只发纯问答）</span>
        ) : (
          effectiveCodes.map(code => {
            const name = watchlist.find(s => s.code === code)?.name || code;
            const isPrimary = code === selectedCode;
            return (
              <span
                key={code}
                title={isPrimary ? '当前选中标的，随上方切换自动更新' : undefined}
                className={cn(
                  'inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs',
                  isPrimary
                    ? 'bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300'
                    : 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300',
                )}
              >
                {isPrimary && <span className="opacity-60">主</span>}
                {name} ({code})
                {!isPrimary && (
                  <button
                    type="button"
                    onClick={() => removeCompareCode(code)}
                    className="hover:text-red-500 transition"
                    title="移除"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
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
                </div>
                {msg.role === 'assistant' && msg.reasoning && (
                  <ReasoningPanel
                    reasoning={msg.reasoning}
                    isStreaming={false}
                    variant="light"
                  />
                )}
              </div>
            </div>
          ))}
          {/* 流式中的回复（本地累积，尚未入 store） */}
          {streamingMsg && (
            <div className="flex justify-start">
              <div className="max-w-[85%] rounded-xl px-3.5 py-2.5 text-sm bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-bl-md">
                <div className="whitespace-pre-wrap break-words leading-relaxed">
                  {streamingMsg.content}
                  <span className="text-blue-500 animate-pulse text-lg font-bold">···</span>
                </div>
                {streamingMsg.reasoning && (
                  <ReasoningPanel
                    reasoning={streamingMsg.reasoning}
                    isStreaming={true}
                    variant="light"
                  />
                )}
              </div>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>
      )}

      <div className="flex gap-2">
        <Input
          id="chat-input"
          type="text"
          value={chatInput}
          onChange={(e) => setChatInput(e.target.value)}
          onKeyDown={handleChatKeyDown}
          placeholder="输入问题，Enter 发送..."
          disabled={isChatStreaming}
          className="rounded-xl px-3.5 py-2.5"
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
