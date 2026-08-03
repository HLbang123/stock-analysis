/**
 * AI 筛选 — LLM 重排
 *
 * 译自 alphasift ranker.py：覆盖率门控 + JSON 容错解析 + 失败回退到规则分排序。
 * 融合公式：final = screen_score * (1 - rankWeight) + llm_score * rankWeight（rankWeight 默认 0.4）。
 * 不用 response_format（兼容各家中转模型），靠 prompt 约束 + 容错解析兜底。
 * 思考型模型（deepseek-v4-flash）会吐 reasoning_content：content 与 reasoning 分开取，
 * content 优先做 JSON 源，reasoning 只作最后兜底（08-03 18 候选曾因 8192 token 被思考烧光而全降级纯规则）。
 */

import { buildChatUrl, buildLLMHeaders, createTimeoutSignal } from '@/lib/llm-client';
import { formatAiError, formatNetworkError } from '@/lib/ai-error';
import type { AiPick, LlmConfig, StrategyPreset } from './types';
import { buildRankingPrompt } from './prompt';

const RANK_WEIGHT = 0.4;
const MIN_COVERAGE = 0.6;
const MAX_RETRIES = 2;
// 非流式单层超时：覆盖中转慢生成整段耗时（07-30 非流式 90s 曾超时，放宽到 300s）
const LLM_TIMEOUT_MS = 300_000;
// 思考型模型（deepseek-v4-flash 会先吐 reasoning_content）会把生成预算烧在思考上，
// 候选越多思考越长：18 只时 8192 曾让 content 为空/只剩前奏 → 3 次 json_parse_failed 全降级纯规则。
// 16384 = 18 只候选 JSON(≈4.5k token) + 思考余量；中转若把 max_tokens 卡得更小会 400，callLlm 内自动降级重试 8192。
const LLM_MAX_TOKENS = 16384;

export interface RankResult {
  picks: AiPick[];
  llmRanked: boolean;
  marketView: string;
  selectionLogic: string;
  portfolioRisk: string;
  coverage: number | null;
  degradation: string[];
}

/** 提取 6 位代码用于匹配（301377.SZ / sz301377 / 301377 → 301377） */
function normalizeCode(s: string): string {
  const m = String(s).match(/\d{6}/);
  return m ? m[0] : String(s).trim();
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
  return v.map((x) => String(x)).filter(Boolean).slice(0, 12);
};

interface RankedItem {
  code: string;
  llm_score?: number;
  confidence?: number;
  sector?: string;
  theme?: string;
  thesis?: string;
  reason?: string;
  risk?: string;
  catalysts?: string[];
  risk_flags?: string[];
  tags?: string[];
  style_fit?: string;
  watch_items?: string[];
  invalidators?: string[];
}

interface RankPayload {
  market_view?: string;
  selection_logic?: string;
  portfolio_risk?: string;
  ranked?: RankedItem[];
}

/** 容错 JSON 解析（去尾逗号、补未闭合括号、提取平衡子串、部分数组拼装） */
function parseJsonLenient(raw: string): RankPayload | null {
  const tryParse = (s: string): RankPayload | null => {
    try {
      return JSON.parse(s) as RankPayload;
    } catch {
      return null;
    }
  };

  // 1. 直接解析
  let parsed = tryParse(raw);
  if (parsed) return parsed;

  // 2. 提取 ```json 围栏或首个平衡 {...}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates: string[] = [];
  if (fenced) candidates.push(fenced[1]);
  const balanced = extractBalanced(raw, '{');
  if (balanced) candidates.push(balanced);
  for (const c of candidates) {
    parsed = tryParse(c);
    if (parsed) return parsed;
    // 3. 去尾逗号
    const noTrailing = c.replace(/,\s*([}\]])/g, '$1');
    parsed = tryParse(noTrailing);
    if (parsed) return parsed;
    // 4. 补未闭合括号
    parsed = tryParse(closeBrackets(noTrailing));
    if (parsed) return parsed;
  }

  // 5. 部分数组：收集所有带 code 的对象
  const items = extractPartialItems(raw);
  if (items.length > 0) return { ranked: items };
  return null;
}

/** 字符感知的括号匹配，返回第一个顶层平衡子串 */
function extractBalanced(s: string, open: string): string | null {
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) {
      if (depth === 0) start = i;
      depth++;
    } else if (c === close) {
      depth--;
      if (depth === 0 && start >= 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/** 统计未闭合的 { [ 并在末尾补齐 */
function closeBrackets(s: string): string {
  let braces = 0;
  let brackets = 0;
  let inStr = false;
  let esc = false;
  for (const c of s) {
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') braces++;
    else if (c === '}') braces = Math.max(0, braces - 1);
    else if (c === '[') brackets++;
    else if (c === ']') brackets = Math.max(0, brackets - 1);
  }
  return s + ']'.repeat(brackets) + '}'.repeat(braces);
}

/** 从任意位置收集所有带 code 键的平衡对象 */
function extractPartialItems(s: string): RankedItem[] {
  const items: RankedItem[] = [];
  let i = 0;
  while (i < s.length) {
    const idx = s.indexOf('{', i);
    if (idx < 0) break;
    const sub = extractBalanced(s.slice(idx), '{');
    if (sub) {
      try {
        const obj = JSON.parse(sub.replace(/,\s*([}\]])/g, '$1'));
        if (obj && typeof obj === 'object' && 'code' in obj) items.push(obj as RankedItem);
      } catch {
        /* skip */
      }
      i = idx + sub.length;
    } else i = idx + 1;
  }
  return items;
}

/** LLM 非流式返回：content 正文 + reasoning 思考过程分开读，避免思考文本污染 JSON 解析 */
interface LlmTextResult {
  content: string;
  reasoning: string;
}

/** chat/completions 返回的 message 字段（只取用到的键，其余不关心） */
interface LlmResponseMessage {
  content?: unknown;
  reasoning_content?: unknown;
  reasoning?: unknown;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: LlmResponseMessage }>;
}

/** 兼容 content 为字符串或 OpenAI 多段 parts 数组的取法 */
function extractContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    let out = '';
    for (const p of content) {
      if (typeof p === 'string') out += p;
      else if (p && typeof p === 'object' && 'text' in p && typeof (p as { text: unknown }).text === 'string') {
        out += (p as { text: string }).text;
      }
    }
    return out;
  }
  return '';
}

/** 取 message.reasoning（兼容 reasoning_content / reasoning 两种字段名） */
function extractReasoning(msg?: LlmResponseMessage): string {
  if (typeof msg?.reasoning_content === 'string') return msg.reasoning_content;
  if (typeof msg?.reasoning === 'string') return msg.reasoning;
  return '';
}

/**
 * 调 LLM（非流式，取完整文本）。
 * 曾改流式（commit 9642955）后中转在流式下不吐 content，全部 empty_response 回退；
 * 改回非流式（07-30 生产数据验证能拿到内容），单层 300s 超时覆盖慢中转整段生成。
 * content 与 reasoning_content 分开返回：reasoning 只是思考过程，不直接作为 JSON 源；
 * 个别思考型中转把答案放思考通道时，由 rankCandidates 把 reasoning 当最后兜底去解析。
 * 中转把 max_tokens 卡得比 LLM_MAX_TOKENS 小时会 400，自动降级用 8192 重试一次。
 */
async function callLlm(prompt: string, cfg: LlmConfig): Promise<LlmTextResult> {
  const url = buildChatUrl(cfg.baseUrl);
  const headers = buildLLMHeaders(cfg.apiKey);
  const { signal, clear } = createTimeoutSignal(LLM_TIMEOUT_MS);
  const post = async (maxTokens: number) => {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: maxTokens,
        stream: false,
      }),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(formatAiError(res.status, text));
    }
    return res.json();
  };
  try {
    let data: ChatCompletionResponse | null = null;
    try {
      data = (await post(LLM_MAX_TOKENS)) as ChatCompletionResponse;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // 400 且错误含 max_tokens 字样（厂商卡上限）→ 用 8192 重试，避免把「可降级」变成「调用失败」
      if (/400|max[_ -]?tokens?|max completion/i.test(msg)) {
        data = (await post(8192)) as ChatCompletionResponse;
      } else {
        throw e;
      }
    }
    const msg = data?.choices?.[0]?.message;
    return { content: extractContent(msg?.content), reasoning: extractReasoning(msg) };
  } catch (e: unknown) {
    const err = e instanceof Error ? e : new Error(String(e));
    const isAbort = err.name === 'AbortError' || /abort/i.test(err.message || '');
    if (isAbort) throw new Error(`LLM 重排超时（${LLM_TIMEOUT_MS / 1000}s）`);
    throw new Error(formatNetworkError(err));
  } finally {
    clear();
  }
}

/** 把 LLM 输出回填到 picks，并计算 final_score（融合） */
function applyRanking(picks: AiPick[], payload: RankPayload): { matched: number; degradation: string[] } {
  const degradation: string[] = [];
  const byCode = new Map<string, AiPick>();
  for (const k of picks) byCode.set(normalizeCode(k.tsCode), k);

  const seen = new Set<string>();
  let matched = 0;
  const ranked = payload.ranked ?? [];

  for (const item of ranked) {
    const code = normalizeCode(item.code ?? '');
    if (!code) continue;
    const k = byCode.get(code);
    if (!k) {
      degradation.push(`unknown_code:${item.code}`);
      continue;
    }
    if (seen.has(code)) {
      degradation.push(`duplicate_code:${item.code}`);
      continue;
    }
    seen.add(code);
    matched++;
    k.llmScore = boundedFloat(item.llm_score, 0, 100, 0);
    k.llmConfidence = boundedFloat(item.confidence, 0, 1, 0.5);
    k.llmSector = safeText(item.sector, 40);
    k.llmTheme = safeText(item.theme, 100);
    k.llmThesis = safeText(item.thesis, 220);
    k.rankingReason = safeText(item.reason, 180);
    k.riskSummary = safeText(item.risk, 180);
    k.llmCatalysts = safeList(item.catalysts);
    k.llmRisks = safeList(item.risk_flags);
    k.llmTags = safeList(item.tags);
    k.llmStyleFit = safeText(item.style_fit, 120);
    k.llmWatchItems = safeList(item.watch_items);
    k.llmInvalidators = safeList(item.invalidators);
  }

  // 未被 LLM 命中的候选：llm_score 按规则分排序线性衰减兜底
  const unmatched = picks.filter((k) => !seen.has(normalizeCode(k.tsCode))).sort((a, b) => b.screenScore - a.screenScore);
  const n = Math.max(picks.length, 1);
  unmatched.forEach((k, i) => {
    if (k.llmScore == null) k.llmScore = 100 - i * (100 / n);
  });

  // 融合
  for (const k of picks) {
    const ls = k.llmScore ?? 0;
    k.finalScore = k.screenScore * (1 - RANK_WEIGHT) + ls * RANK_WEIGHT;
  }
  return { matched, degradation };
}

/**
 * LLM 重排主入口。失败/覆盖率不足 → 回退到 screen_score 排序（ranked=false）。
 */
export async function rankCandidates(
  picks: AiPick[],
  preset: StrategyPreset,
  cfg: LlmConfig,
): Promise<RankResult> {
  const degradation: string[] = [];
  if (picks.length === 0 || !preset.llmRerank) {
    return emptyFallback(picks, preset, degradation);
  }

  // 送 LLM 的候选数 = maxOutput(20)。旧版 3 倍封顶 30 让输出逼近 max_tokens 触发覆盖率回退，降到 20 保证可靠交付
  const topK = Math.min(Math.max(preset.maxOutput, 10), picks.length);
  const candidates = [...picks].sort((a, b) => b.screenScore - a.screenScore).slice(0, topK);
  const candidateMap = new Map(candidates.map((k) => [normalizeCode(k.tsCode), k]));
  // 池外候选先按规则分排好，作为 LLM 命中后的尾部
  const rest = picks.filter((k) => !candidateMap.has(normalizeCode(k.tsCode))).sort((a, b) => b.screenScore - a.screenScore);

  let prompt = buildRankingPrompt(candidates, preset);
  let payload: RankPayload | null = null;
  let coverage = 0;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      prompt += `\n\n上一次输出不是合法 JSON 或 ranked 数组缺少候选。本次必须只返回严格 JSON：ranked 数组长度必须等于 ${candidates.length}，每个 code 必须与下方候选列表完全一致，不得遗漏任何一个，不得编造候选池外的代码。`;
    }
    let result: LlmTextResult;
    try {
      result = await callLlm(prompt, cfg);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      degradation.push(`llm_call_failed:${msg}`);
      return fallback(picks, preset, degradation, `LLM 调用失败：${msg}`);
    }
    // content 优先；个别中转把答案放思考通道时，reasoning 作最后兜底（但那是散文，多半解析失败，靠 max_tokens 余量治本）
    const raw = result.content.trim() || result.reasoning.trim();
    if (!raw) {
      degradation.push('empty_response');
      continue;
    }
    if (!result.content.trim()) {
      degradation.push('reasoning_content_fallback');
    }
    payload = parseJsonLenient(raw);
    if (!payload) {
      // 记录原始输出前 300 字，下次再失败时能定位 LLM 实际吐了什么
      console.error(`[ai-screen/ranker] json_parse_failed attempt${attempt + 1}/${MAX_RETRIES + 1} candidates=${candidates.length}:`, JSON.stringify(raw.slice(0, 300)));
      degradation.push('json_parse_failed');
      continue;
    }
    const matched = payload.ranked?.filter((r) => candidateMap.has(normalizeCode(r.code ?? ''))).length ?? 0;
    coverage = matched / Math.max(candidates.length, 1);
    if (coverage >= MIN_COVERAGE) break;
    degradation.push(`low_coverage:${coverage.toFixed(2)}@attempt${attempt + 1}`);
  }

  if (!payload || coverage < MIN_COVERAGE) {
    degradation.push(`coverage_below_threshold:${coverage.toFixed(2)}`);
    return fallback(picks, preset, degradation, 'LLM 覆盖率不足，回退规则分排序');
  }

  // 回填 LLM 输出到 candidates
  const { degradation: dg } = applyRanking(candidates, payload);
  degradation.push(...dg);
  // 池外候选：final = screen_score（llm 未介入）
  for (const k of rest) k.finalScore = k.screenScore;

  const merged = [...candidates, ...rest].sort((a, b) => b.finalScore - a.finalScore);
  merged.forEach((k, i) => (k.rank = i + 1));

  return {
    picks: merged,
    llmRanked: true,
    marketView: safeText(payload!.market_view, 260),
    selectionLogic: safeText(payload!.selection_logic, 360),
    portfolioRisk: safeText(payload!.portfolio_risk, 360),
    coverage,
    degradation,
  };
}

function fallback(picks: AiPick[], _preset: StrategyPreset, degradation: string[], reason: string): RankResult {
  const sorted = [...picks].sort((a, b) => b.screenScore - a.screenScore);
  for (const k of sorted) {
    k.finalScore = k.screenScore;
    k.llmScore = null;
    k.rank = 0;
  }
  sorted.forEach((k, i) => (k.rank = i + 1));
  degradation.push(`fallback:${reason}`);
  return { picks: sorted, llmRanked: false, marketView: '', selectionLogic: '', portfolioRisk: '', coverage: null, degradation };
}

function emptyFallback(picks: AiPick[], _preset: StrategyPreset, degradation: string[]): RankResult {
  const sorted = [...picks].sort((a, b) => b.screenScore - a.screenScore);
  for (const k of sorted) k.finalScore = k.screenScore;
  sorted.forEach((k, i) => (k.rank = i + 1));
  return { picks: sorted, llmRanked: false, marketView: '', selectionLogic: '', portfolioRisk: '', coverage: null, degradation };
}
