/**
 * AI 对话 — 浏览器直连版（镜像 /api/ai/chat 的编排）
 *
 * 系统提示 + 3 轮工具调用循环 + 最终流式直答，全部从浏览器直发 provider：
 * - 工具轮：非流式带 tools（60s 超时），有 tool_calls 就执行（executeToolBrowser）后继续
 * - 无 tool_calls → content 就是答案，直接给前端
 * - 3 轮用尽或工具轮失败 → 降级无工具流式直答
 * - 用户取消（AbortError）原样冒泡；连接层失败由调用方判定降级服务器中转
 */

import { CHAT_SYSTEM_PROMPT } from '@/lib/chat-system-prompt';
import { CHAT_TOOLS } from '@/lib/chat-tools-defs';
import { executeToolBrowser } from './browser-tools';
import { chatCompletionDirect, streamChatDirect, type LlmConfigLike } from '@/services/llm/browser-client';
import type { LlmDelta } from '@/lib/llm-stream';

export interface ChatDirectOptions {
  messages: { role: string; content: string }[];
  stockContext?: string;
  cfg: LlmConfigLike;
  signal: AbortSignal;
  onDelta: (d: LlmDelta) => void;
}

export async function streamChatDirectChat(opts: ChatDirectOptions): Promise<void> {
  const { messages, stockContext, cfg, signal, onDelta } = opts;

  let systemContent = CHAT_SYSTEM_PROMPT;
  if (stockContext) {
    systemContent += `\n\n## 当前附带的股票数据\n（可能包含多只股票，用于对比分析；请按用户问题横向对比或分别分析）\n${stockContext}`;
  }
  const allMessages: any[] = [{ role: 'system', content: systemContent }, ...messages];

  // 多轮工具调用（最多 3 轮，镜像服务器版）：每轮非流式带 tools，有 tool_calls 就执行后继续
  let resolved = false;
  for (let round = 0; round < 3; round++) {
    let toolData;
    try {
      toolData = await chatCompletionDirect({
        baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model,
        messages: allMessages,
        tools: CHAT_TOOLS,
        toolChoice: 'auto',
        temperature: 0.7, maxTokens: 4096,
        signal, timeoutMs: 60000,
      });
    } catch (e) {
      if (signal.aborted) throw e; // 用户取消，原样冒泡
      break; // 工具轮失败（业务/网络）→ 降级无工具流式直答
    }

    const toolCalls = toolData.toolCalls;
    if (!toolCalls || toolCalls.length === 0) {
      // 不再调工具 → content 就是答案
      if (toolData.content) {
        onDelta({ content: toolData.content });
        resolved = true;
      }
      break;
    }

    // 执行工具调用（assistant tool_calls 消息原样回传，OpenAI 规范）
    allMessages.push({ role: 'assistant', content: toolData.content || null, tool_calls: toolCalls });
    for (const tc of toolCalls) {
      const args = JSON.parse(tc.function?.arguments || '{}');
      const result = await executeToolBrowser(tc.function.name, args);
      allMessages.push({ role: 'tool', tool_call_id: tc.id, content: result });
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
