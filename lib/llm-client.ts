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

/**
 * 格式化长数字串，避免中转站敏感信息风控误判。
 *
 * 中转站风控会先剥掉逗号/空格/小数点等分隔符，再匹配 11 位手机号 / 18 位身份证，
 * 故千分位逗号无效；而中文字符（亿/万亿）不会被剥，能真正打断数字串匹配。
 *
 * 策略：9+ 位连续数字 → 中文单位化（≥1e12 用万亿，否则用亿），如
 *   12223234200 → 122.23亿
 *   73577146698827 → 73.58万亿
 * 负号保留；小数部分丢弃（亿级精度足够）。
 *
 * 阈值 9 位：避开 6 位股票代码、8 位日期（YYYYMMDD）、常见价格/百分比。
 * 副作用：9+ 位大数被四舍五入到亿级——金融分析足够，且这些大数通常已被
 * fmtMv/fmtFlow 单位化，此函数仅兜底 AI 回显等漏网的裸大数。
 */
export function defuseLongDigitRuns(text: string): string {
  return text.replace(/(?<!\d)(\d{9,})(?:\.\d+)?(?!\d)/g, (_m, intPart: string) => {
    const n = parseInt(intPart, 10);
    const abs = Math.abs(n);
    if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}万亿`;
    return `${(n / 1e8).toFixed(2)}亿`;
  });
}

/** LLM 路由统一的异常响应（AbortError → 504，其他 → 500） */
export function llmRouteError(error: Error, timeoutMessage: string): NextResponse {
  if (error.name === 'AbortError') {
    return NextResponse.json({ error: timeoutMessage }, { status: 504 });
  }
  return NextResponse.json({ error: formatNetworkError(error) }, { status: 500 });
}
