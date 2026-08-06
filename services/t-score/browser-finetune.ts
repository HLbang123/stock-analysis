/**
 * 波段评分 LLM 微调 — 浏览器直连版（镜像 /api/ai/t-score 的完整逻辑）
 *
 * 客户端已算好确定性 buyScore/sellScore，本模块只做：LLM 调用(非流式) → 容错 JSON 解析
 * → 覆盖率门控 + 1 重试 → ±15 有界融合 → 合规后处理。失败优雅降级回退纯因子分。
 *
 * 降级策略：
 * - 连接层失败（CORS/TypeError/超时）→ 降级服务器 /api/ai/t-score（兜底中转）
 * - LLM 业务失败（HTTP 错误/解析失败/覆盖率不足）→ 本地回退纯因子分（与服务器行为一致）
 */

import { chatCompletionDirect, LlmHttpError, isDirectConnectionError, type LlmConfigLike } from '@/services/llm/browser-client';
import { postJSON } from '@/services/api';

const LLM_TIMEOUT_MS = 60_000;
const LLM_MAX_TOKENS = 1536; // analysis(180字)+双理由(240字)+调整/标签 ≈ 800-1000 token
const MIN_COVERAGE = 0.6;
const MAX_RETRIES = 1;

interface TscorePayload {
  buy_adjust?: number | string;
  sell_adjust?: number | string;
  buy_reason?: string;
  sell_reason?: string;
  analysis?: string;
  confidence?: number | string;
  tags?: unknown[];
}

const boundedFloat = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
};
const safeText = (v: unknown, max: number): string => {
  if (v == null) return '';
  return String(v).slice(0, max);
};
const safeList = (v: unknown): string[] => {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x)).filter(Boolean).slice(0, 6);
};
const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const isNum = (v: unknown) => (typeof v === 'number' ? Number.isFinite(v) : typeof v === 'string' ? Number.isFinite(parseFloat(v)) : false);

/** 合规后处理：把违规词替换为合规措辞（system prompt 已禁，这里兜底） */
function complianceScrub(s: string): string {
  return s
    .replace(/个股|股票/g, '标的')
    .replace(/A股/g, '全市场')
    .replace(/做T/g, '波段')
    .replace(/推荐|建议/g, '信号参考');
}

/** 容错 JSON 解析（去 ```json 围栏、平衡括号、补未闭合、去尾逗号） */
function parseJsonLenient(raw: string): TscorePayload | null {
  const tryParse = (s: string): TscorePayload | null => {
    try { return JSON.parse(s) as TscorePayload; } catch { return null; }
  };
  let parsed = tryParse(raw);
  if (parsed) return parsed;

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates: string[] = [];
  if (fenced) candidates.push(fenced[1]);
  const balanced = extractBalanced(raw);
  if (balanced) candidates.push(balanced);
  for (const c of candidates) {
    parsed = tryParse(c);
    if (parsed) return parsed;
    const noTrailing = c.replace(/,\s*([}\]])/g, '$1');
    parsed = tryParse(noTrailing);
    if (parsed) return parsed;
    parsed = tryParse(closeBrackets(noTrailing));
    if (parsed) return parsed;
  }
  return null;
}

function extractBalanced(s: string): string | null {
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}') { depth--; if (depth === 0 && start >= 0) return s.slice(start, i + 1); }
  }
  return null;
}

function closeBrackets(s: string): string {
  let braces = 0, inStr = false, esc = false;
  for (const c of s) {
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') braces++;
    else if (c === '}') braces = Math.max(0, braces - 1);
  }
  return s + '}'.repeat(braces);
}

async function callLlm(systemPrompt: string, userPrompt: string, cfg: LlmConfigLike, signal?: AbortSignal): Promise<string> {
  const { content } = await chatCompletionDirect({
    baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.2,
    maxTokens: LLM_MAX_TOKENS,
    signal,
    timeoutMs: LLM_TIMEOUT_MS,
  });
  return content;
}

export interface TscoreFinetuneResult {
  finalBuy: number;
  finalSell: number;
  buyAdjust: number;
  sellAdjust: number;
  buyReason: string;
  sellReason: string;
  analysis: string;
  confidence: number;
  tags: string[];
  llmAdjusted: boolean;
  coverage: number | null;
  degradation: string[];
}

function fallback(buyScore: number, sellScore: number, degradation: string[], reason: string): TscoreFinetuneResult {
  return {
    finalBuy: Math.round(buyScore),
    finalSell: Math.round(sellScore),
    buyAdjust: 0,
    sellAdjust: 0,
    buyReason: '',
    sellReason: '',
    analysis: '',
    confidence: 0,
    tags: [],
    llmAdjusted: false,
    coverage: null,
    degradation: [...degradation, `fallback:${reason}`],
  };
}

export interface FinetuneParams {
  systemPrompt: string;
  userPrompt: string;
  cfg: LlmConfigLike;
  buyScore: number;
  sellScore: number;
  signal?: AbortSignal;
}

/**
 * 波段评分 LLM 微调（浏览器直连）。返回结构与原 /api/ai/t-score 完全一致。
 */
export async function finetuneTScore(params: FinetuneParams): Promise<TscoreFinetuneResult> {
  const { systemPrompt, userPrompt, cfg, buyScore, sellScore, signal } = params;
  const degradation: string[] = [];

  let payload: TscorePayload | null = null;
  let coverage = 0;
  let raw = '';

  try {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        raw = await callLlm(
          attempt === 0 ? systemPrompt : systemPrompt + '\n\n上一次输出未满足结构化要求，请重新返回严格 JSON。',
          userPrompt, cfg, signal,
        );
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') throw e; // 用户取消，原样冒泡
        degradation.push(`llm_call_failed:${e instanceof Error ? e.message : String(e)}`);
        // 连接层失败（CORS/TypeError/超时）→ 降级服务器中转
        if (isDirectConnectionError(e)) {
          try {
            return await postJSON<TscoreFinetuneResult>('/api/ai/t-score', {
              systemPrompt, userPrompt,
              baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model,
              buyScore, sellScore,
            }, { signal });
          } catch (e2) {
            degradation.push(`server_fallback_failed:${e2 instanceof Error ? e2.message : String(e2)}`);
          }
        }
        return fallback(buyScore, sellScore, degradation, 'LLM 调用失败');
      }
      payload = parseJsonLenient(raw);
      if (!payload) { degradation.push('json_parse_failed'); continue; }

      const hasBuy = isNum(payload.buy_adjust);
      const hasSell = isNum(payload.sell_adjust);
      coverage = hasBuy && hasSell ? 1 : hasBuy ? 0.6 : 0;
      if (coverage >= MIN_COVERAGE) break;
      degradation.push(`low_coverage:${coverage.toFixed(2)}@attempt${attempt + 1}`);
    }
  } catch (e) {
    // 重试循环外的异常（signal 取消等）→ 本地回退，不让评分失败；用户取消原样冒泡
    if (e instanceof Error && e.name === 'AbortError') throw e;
    degradation.push(`unexpected:${e instanceof Error ? e.message : String(e)}`);
    return fallback(buyScore, sellScore, degradation, 'LLM 微调异常');
  }

  if (!payload || coverage < MIN_COVERAGE) {
    degradation.push(`coverage_below_threshold:${coverage.toFixed(2)}`);
    return fallback(buyScore, sellScore, degradation, 'LLM 覆盖率不足');
  }

  const buyAdjust = boundedFloat(payload.buy_adjust, -15, 15, 0);
  const sellAdjust = boundedFloat(payload.sell_adjust, -15, 15, 0);
  const finalBuy = Math.round(clamp(buyScore + buyAdjust));
  const finalSell = Math.round(clamp(sellScore + sellAdjust));

  return {
    finalBuy,
    finalSell,
    buyAdjust,
    sellAdjust,
    buyReason: complianceScrub(safeText(payload.buy_reason, 200)),
    sellReason: complianceScrub(safeText(payload.sell_reason, 200)),
    analysis: complianceScrub(safeText(payload.analysis, 400)),
    confidence: boundedFloat(payload.confidence, 0, 1, 0.5),
    tags: safeList(payload.tags),
    llmAdjusted: true,
    coverage,
    degradation,
  };
}
