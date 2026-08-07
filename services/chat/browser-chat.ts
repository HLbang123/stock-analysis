/**
 * AI 对话 — 浏览器直连版（镜像 /api/ai/chat 的编排）
 *
 * 系统提示 + 3 轮工具调用循环 + 最终流式直答，全部从浏览器直发 provider：
 * - 全部轮次流式（工具分片静默累积，正文逐字直播）：不调工具时答案也是逐字吐出，
 *   不再"攒满整段一下蹦出来"
 * - 流式工具轮**空返回或 HTTP 错误时回退非流式重试一轮**（部分中转不支持 stream+tools，
 *   会 400 或吞掉 tool_calls——非流式兜底保住工具能力不静默退化）
 * - 有 tool_calls 就执行（executeToolBrowser）后继续；3 轮用尽或全部失败 → 降级无工具流式直答
 * - 用户取消（AbortError）原样冒泡；连接层失败由调用方判定降级服务器中转
 */

import { CHAT_SYSTEM_PROMPT } from '@/lib/chat-system-prompt';
import { CHAT_TOOLS } from '@/lib/chat-tools-defs';
import { executeToolBrowser } from './browser-tools';
import { streamChatDirect, streamChatDirectWithTools, chatCompletionDirect, LlmHttpError, type LlmConfigLike } from '@/services/llm/browser-client';
import type { LlmDelta } from '@/lib/llm-stream';

export interface ChatDirectOptions {
  messages: { role: string; content: string }[];
  stockContext?: string;
  cfg: LlmConfigLike;
  signal: AbortSignal;
  onDelta: (d: LlmDelta) => void;
}

interface ToolRoundResult {
  content: string;
  toolCalls: { id: string; type: string; function: { name: string; arguments: string } }[];
}

export async function streamChatDirectChat(opts: ChatDirectOptions): Promise<void> {
  const { messages, stockContext, cfg, signal, onDelta } = opts;

  let systemContent = CHAT_SYSTEM_PROMPT;
  if (stockContext) {
    systemContent += `\n\n## 当前附带的股票数据\n（可能包含多只股票，用于对比分析；请按用户问题横向对比或分别分析）\n${stockContext}`;
  }
  const allMessages: any[] = [{ role: 'system', content: systemContent }, ...messages];

  // 非流式兜底（原实现）：中转不支持 stream+tools 时保住工具能力；拿到的正文经 onDelta 展示
  const fallbackRound = async (): Promise<ToolRoundResult | null> => {
    try {
      const fb = await chatCompletionDirect({
        baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model,
        messages: allMessages,
        tools: CHAT_TOOLS, toolChoice: 'auto',
        temperature: 0.7, maxTokens: 4096,
        signal, timeoutMs: 60000,
      });
      if (fb.content) onDelta({ content: fb.content });
      return { content: fb.content || '', toolCalls: fb.toolCalls ?? [] };
    } catch {
      return null; // 兜底也失败 → 降级无工具流式
    }
  };

  // 多轮工具调用（最多 3 轮，镜像服务器版）：每轮流式带 tools，正文直播、工具分片静默累积
  let resolved = false;
  for (let round = 0; round < 3; round++) {
    let result: ToolRoundResult | null = null;
    try {
      const r = await streamChatDirectWithTools({
        baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model,
        messages: allMessages,
        tools: CHAT_TOOLS,
        toolChoice: 'auto',
        temperature: 0.7, maxTokens: 4096,
        signal, timeoutMs: 60000,
        onDelta,
      });
      result = r;
      // 流式正常但空返回（content 和 tool_calls 都没有）→ 该中转可能吞了 stream 模式 → 非流式兜底
      if (!r.content && r.toolCalls.length === 0) {
        result = await fallbackRound();
      }
    } catch (e) {
      if (signal.aborted) throw e; // 用户取消，原样冒泡
      // 业务错误（如 400：中转不支持 stream+tools）→ 非流式兜底；网络/超时 → 直接降级
      result = e instanceof LlmHttpError ? await fallbackRound() : null;
    }
    if (!result) break; // 全部失败 → 降级无工具流式

    const toolCalls = result.toolCalls;
    if (!toolCalls || toolCalls.length === 0) {
      // 不再调工具 → 正文已直播完毕；空内容则降级流式兜底
      if (result.content) resolved = true;
      break;
    }

    // 执行工具调用（assistant tool_calls 消息原样回传，OpenAI 规范）
    allMessages.push({ role: 'assistant', content: result.content || null, tool_calls: toolCalls });
    for (const tc of toolCalls) {
      const args = JSON.parse(tc.function?.arguments || '{}');
      const toolResult = await executeToolBrowser(tc.function.name, args);
      allMessages.push({ role: 'tool', tool_call_id: tc.id, content: toolResult });
    }
  }

  // 3 轮用尽或降级且未直接拿到答案 → 最终流式输出（不带工具）
  if (!resolved) {
    await streamChatDirect({
      baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model,
      messages: allMessages,
      temperature: 0.7, maxTokens: 4096,
      signal,
      onDelta,
    });
  }
}
