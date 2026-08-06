/**
 * LLM 纯函数工具 — 不依赖 next/server，浏览器与服务器共用。
 * 服务器侧经 lib/llm-client.ts re-export 保持旧 import 兼容。
 */

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
