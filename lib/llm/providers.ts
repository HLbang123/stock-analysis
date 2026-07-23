/**
 * LLM Provider 能力层
 *
 * 目的：把不同 provider / 模型的差异（是否支持 function calling、reasoning 字段名、
 * temperature 约束、GLM thinking 参数等）隔离到一处，AI 路由不再写死 OpenAI 兼容假设。
 *
 * 当前用户主力是 DeepSeek 和 GLM，所以这里主要处理两件事：
 * 1. supportsTools —— reasoning 模型（deepseek-reasoner / glm-z1 / o1 / o3 等）普遍
 *    不支持 function calling，chat 路由据此降级为无工具直答，避免报错。
 * 2. normalizeRequest —— 请求体按 provider/模型注入怪癖的钩子。当前透传，预留
 *    GLM thinking 参数、reasoning 模型 temperature 约束的注入点。
 *
 * reasoning_content 的解析在 lib/llm-stream.ts 的 readLlmDeltas 里统一兜底读取，
 * 不依赖这里的标记——只要模型吐了就读到。
 */

export interface ProviderCapabilities {
  id: string;
  /** 此模型是否支持 function calling（不支持时 chat 路由应跳过工具调用） */
  supportsTools: (model: string) => boolean;
  /** 按 provider/模型怪癖调整请求体；当前透传，预留扩展点 */
  normalizeRequest: (body: Record<string, unknown>, model: string) => Record<string, unknown>;
}

/** 不支持 function calling 的模型名匹配规则（reasoning 模型为主） */
const NO_TOOLS_PATTERNS: RegExp[] = [
  /deepseek-reasoner/i,
  /reasoner/i,          // 通配 *-reasoner
  /\bglm-z1\b/i,
  /glm-zero/i,
  /\bo1\b/i,
  /\bo3\b/i,
  /\bo4-mini\b/i,
];

const DEFAULT_PROVIDER: ProviderCapabilities = {
  id: 'openai-compatible',
  supportsTools: (model) => !NO_TOOLS_PATTERNS.some(re => re.test(model)),
  normalizeRequest: (body) => body,
};

/**
 * 根据 baseUrl + model 选 provider。
 * 目前所有走的都是 OpenAI 兼容协议，统一返回默认 provider；
 * 以后若接 Anthropic 原生 Messages API 等不兼容协议，在此按 baseUrl 分流。
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function getProvider(baseUrl: string, model: string): ProviderCapabilities {
  return DEFAULT_PROVIDER;
}
