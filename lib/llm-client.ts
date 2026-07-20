import { NextResponse } from 'next/server';
import { formatNetworkError } from '@/lib/ai-error';

/** 去除 Base URL 末尾的斜杠，避免拼接出双斜杠 */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '');
}

/** 构建 OpenAI 兼容 API 的 chat/completions 完整地址 */
export function buildChatUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/chat/completions`;
}

/** 构建 LLM 请求头（带可选 Bearer 鉴权） */
export function buildLLMHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  return headers;
}

/** 创建带超时的 AbortSignal，返回清理函数 */
export function createTimeoutSignal(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/** SSE 流式响应所需的响应头 */
export const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
  'X-Accel-Buffering': 'no',
};

/** 包装 ReadableStream 为 SSE 响应 */
export function sseResponse(stream: ReadableStream): Response {
  return new Response(stream, { headers: SSE_HEADERS });
}

/** LLM 路由统一的异常响应（AbortError → 504，其他 → 500） */
export function llmRouteError(error: Error, timeoutMessage: string): NextResponse {
  if (error.name === 'AbortError') {
    return NextResponse.json({ error: timeoutMessage }, { status: 504 });
  }
  return NextResponse.json({ error: formatNetworkError(error) }, { status: 500 });
}
