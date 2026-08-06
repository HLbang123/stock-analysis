import { NextResponse } from 'next/server';
import { formatNetworkError } from '@/lib/ai-error';

// 纯函数工具从 shared 模块 re-export（浏览器与服务器共用，见 lib/llm/shared.ts）
export {
  normalizeBaseUrl,
  buildChatUrl,
  buildLLMHeaders,
  createTimeoutSignal,
} from '@/lib/llm/shared';

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
