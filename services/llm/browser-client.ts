/**
 * 浏览器直连 LLM client — OpenAI 兼容 chat/completions
 *
 * 用户用自己的 key 从浏览器直连 provider（DeepSeek/GLM 等），不再绕服务器中转：
 * - 服务器出站流量归零（300 人 AI 流量不再吃香港服务器带宽）
 * - 延迟少一跳香港往返
 * - key 不再汇聚到服务器
 *
 * 配套降级约定（各功能调用方遵守）：
 * - 连接层失败（CORS / TypeError / 超时）→ isDirectConnectionError 判定 → 降级到服务器中转路由
 * - HTTP 业务错误（400/401/429/5xx 等）→ 抛 LlmHttpError，不降级（服务器重跑结果一样）
 * - 用户主动取消（AbortError）→ 原样抛，绝不降级
 */

import { buildChatUrl, buildLLMHeaders } from '@/lib/llm/shared';
import { readLlmDeltas, readLlmDeltasWithTools, type AccumulatedToolCall, type LlmDelta } from '@/lib/llm-stream';
import { formatAiError, formatNetworkError } from '@/lib/ai-error';

export interface LlmConfigLike {
  baseUrl: string;
  apiKey?: string;
  model: string;
}

/** HTTP 业务错误（LLM 返回非 2xx）— 不触发降级 */
export class LlmHttpError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = 'LlmHttpError';
  }
}

/** 判定是否"直连不可达"（CORS/网络层/超时）→ 应降级到服务器中转。用户取消（AbortError）除外。 */
export function isDirectConnectionError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e.name === 'AbortError' || e.name === 'LlmHttpError' || e.name === 'FatalApiError') return false;
  return e.name === 'TypeError'
    || /fetch|network|超时|timeout/i.test(e.message || '');
}

interface BaseChatOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  messages: { role: string; content?: string | null }[];
  temperature?: number;
  maxTokens?: number;
  tools?: unknown[];
  toolChoice?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** 可选：流结束时回调 finish_reason（"stop" 正常 / "length" 被 max_tokens 截断），调用方据此判断是否截断 */
  onFinish?: (reason: string) => void;
}

/** 合并外部取消信号与内部超时；返回 { signal, clear, timedOut } */
function mergeSignals(external: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  clear: () => void;
  timedOut: () => boolean;
} {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
  const onExtAbort = () => ctrl.abort();
  external?.addEventListener('abort', onExtAbort);
  return {
    signal: ctrl.signal,
    clear: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExtAbort);
    },
    timedOut: () => timedOut,
  };
}

function buildBody(opts: BaseChatOptions, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.maxTokens ?? 4096,
    stream,
  };
  if (opts.tools) body.tools = opts.tools;
  if (opts.toolChoice) body.tool_choice = opts.toolChoice;
  return body;
}

/**
 * 非流式调用（工具轮 / t-score 微调用）。返回 content + 可选 tool_calls。
 */
export async function chatCompletionDirect(opts: BaseChatOptions): Promise<{
  content: string;
  toolCalls?: { id: string; type: string; function: { name: string; arguments: string } }[];
}> {
  const url = buildChatUrl(opts.baseUrl);
  const { signal, clear, timedOut } = mergeSignals(opts.signal, opts.timeoutMs ?? 120000);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: buildLLMHeaders(opts.apiKey),
      body: JSON.stringify(buildBody(opts, false)),
      signal,
    });
  } catch (e) {
    clear();
    if (timedOut()) throw new Error('AI 请求超时（120秒），模型未在限定时间内响应');
    if (opts.signal?.aborted) throw e as Error; // 用户取消，原样抛
    throw new Error(formatNetworkError(e as Error), { cause: e });
  }
  clear();

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new LlmHttpError(formatAiError(res.status, text), res.status);
  }
  const data = await res.json();
  const message = data?.choices?.[0]?.message;
  return {
    content: typeof message?.content === 'string' ? message.content : '',
    toolCalls: message?.tool_calls ?? undefined,
  };
}

/**
 * 流式调用（对话/深度分析用）。onDelta 逐个增量回调（content / reasoning）。
 */
export async function streamChatDirect(opts: BaseChatOptions & { onDelta: (d: LlmDelta) => void }): Promise<void> {
  const url = buildChatUrl(opts.baseUrl);
  const { signal, clear, timedOut } = mergeSignals(opts.signal, opts.timeoutMs ?? 120000);
  const timeoutSecs = Math.round((opts.timeoutMs ?? 120000) / 1000);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: buildLLMHeaders(opts.apiKey),
      body: JSON.stringify(buildBody(opts, true)),
      signal,
    });
  } catch (e) {
    clear();
    if (timedOut()) throw new Error(`AI 请求超时（${timeoutSecs}秒），模型未在限定时间内响应`);
    if (opts.signal?.aborted) throw e as Error; // 用户取消，原样抛
    throw new Error(formatNetworkError(e as Error), { cause: e });
  }
  if (!res.ok) {
    clear();
    const text = await res.text().catch(() => '');
    throw new LlmHttpError(formatAiError(res.status, text), res.status);
  }

  // 超时覆盖到流式读取全程（定时器在 fetch 头返回后仍存活）：流式中途 abort 在此转成超时错误，
  // 而不是以 AbortError 冒泡被上层误判为"用户取消"而静默丢弃整个分析。
  try {
    await readLlmDeltas(res, opts.onDelta, opts.onFinish);
  } catch (e) {
    if (timedOut()) throw new Error(`AI 请求超时（${timeoutSecs}秒），模型未在限定时间内响应`);
    if (opts.signal?.aborted) throw e as Error;
    throw e;
  } finally {
    clear();
  }
}

/**
 * 流式调用 + 工具调用分片累积（对话工具轮用）。
 * content/reasoning 逐字直播；tool_calls 静默累积，流结束返回（空数组 = 本轮纯文本回答）。
 * 返回 content 全量供 assistant 消息回传（OpenAI 规范要求 tool_calls 轮带上 content）。
 */
export async function streamChatDirectWithTools(
  opts: BaseChatOptions & { onDelta: (d: LlmDelta) => void }
): Promise<{ content: string; toolCalls: AccumulatedToolCall[] }> {
  const url = buildChatUrl(opts.baseUrl);
  const { signal, clear, timedOut } = mergeSignals(opts.signal, opts.timeoutMs ?? 120000);
  const timeoutSecs = Math.round((opts.timeoutMs ?? 120000) / 1000);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: buildLLMHeaders(opts.apiKey),
      body: JSON.stringify(buildBody(opts, true)),
      signal,
    });
  } catch (e) {
    clear();
    if (timedOut()) throw new Error(`AI 请求超时（${timeoutSecs}秒），模型未在限定时间内响应`);
    if (opts.signal?.aborted) throw e as Error; // 用户取消，原样抛
    throw new Error(formatNetworkError(e as Error), { cause: e });
  }
  if (!res.ok) {
    clear();
    const text = await res.text().catch(() => '');
    throw new LlmHttpError(formatAiError(res.status, text), res.status);
  }
  let content = '';
  const toolCalls = await readLlmDeltasWithTools(res, (d) => {
    if (d.content) content += d.content;
    opts.onDelta(d);
  }).catch((e) => {
    if (timedOut()) throw new Error(`AI 请求超时（${timeoutSecs}秒），模型未在限定时间内响应`);
    if (opts.signal?.aborted) throw e as Error;
    throw e;
  }).finally(() => clear());
  return { content, toolCalls };
}
