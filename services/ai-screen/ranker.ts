/**
 * AI 筛选 — LLM 重排
 *
 * 译自 alphasift ranker.py：覆盖率门控 + JSON 容错解析 + 失败回退到规则分排序。
 * 融合公式：final = screen_score * (1 - rankWeight) + llm_score * rankWeight（rankWeight 默认 0.4）。
 * 不用 response_format（兼容各家中转模型），靠 prompt 约束 + 容错解析兜底。
 */

import { buildChatUrl, buildLLMHeaders } from '@/lib/llm-client';
import { formatAiError, formatNetworkError } from '@/lib/ai-error';
import type { AiPick, LlmConfig, StrategyPreset } from './types';
import { buildRankingPrompt } from './prompt';

const RANK_WEIGHT = 0.4;
const MIN_COVERAGE = 0.6;
const MAX_RETRIES = 2;
// 流式双层超时：只要模型持续吐字就不会因整体超时被砍
const LLM_IDLE_TIMEOUT_MS = 30_000; // 两个 chunk 之间静默超过 30s 才 abort
const LLM_HARD_TIMEOUT_MS = 180_000; // 整体硬上限，兜底极端慢请求
const LLM_MAX_TOKENS = 8192; // 30 只候选×12 字段(含 thesis/reason/risk 散文+5 数组)约 7k token,4096 会截断丢项触发覆盖率回退

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

/**
 * 调 LLM（流式，逐 chunk 拼接完整文本）。
 * 流式下用"空闲超时 + 硬上限"双层超时：模型持续吐字就不算超时，避免非流式下 7k token 生成撞 90s 整体超时。
 */
async function callLlm(prompt: string, cfg: LlmConfig): Promise<string> {
  const url = buildChatUrl(cfg.baseUrl);
  const headers = buildLLMHeaders(cfg.apiKey);
  const controller = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let hardTimer: ReturnType<typeof setTimeout> | null = null;
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), LLM_IDLE_TIMEOUT_MS);
  };
  const clearAll = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (hardTimer) clearTimeout(hardTimer);
    idleTimer = null;
    hardTimer = null;
  };
  hardTimer = setTimeout(() => controller.abort(), LLM_HARD_TIMEOUT_MS);
  resetIdle();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: LLM_MAX_TOKENS,
        stream: true,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(formatAiError(res.status, text));
    }
    if (!res.body) throw new Error('LLM 响应无 body');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let full = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      resetIdle();
      buf += decoder.decode(value, { stream: true });
      // 按 SSE 行解析：每行 `data: {json}`，结尾 `data: [DONE]`
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line || !line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          clearAll();
          return full;
        }
        try {
          const json = JSON.parse(data);
          const delta = json?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta) full += delta;
        } catch {
          // 跨 chunk 的不完整 JSON 行，忽略，等下一块补齐
        }
      }
    }
    return full;
  } catch (e: any) {
    const isAbort = e.name === 'AbortError' || /abort/i.test(e.message || '');
    if (isAbort) throw new Error('LLM 重排超时（空闲30s/整体180s）');
    throw new Error(formatNetworkError(e));
  } finally {
    clearAll();
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

  // 送 LLM 的候选数：maxOutput 的 3 倍封顶 30，控制成本
  const topK = Math.min(Math.max(preset.maxOutput * 3, 10), 30, picks.length);
  const candidates = [...picks].sort((a, b) => b.screenScore - a.screenScore).slice(0, topK);
  const candidateMap = new Map(candidates.map((k) => [normalizeCode(k.tsCode), k]));
  // 池外候选先按规则分排好，作为 LLM 命中后的尾部
  const rest = picks.filter((k) => !candidateMap.has(normalizeCode(k.tsCode))).sort((a, b) => b.screenScore - a.screenScore);

  let prompt = buildRankingPrompt(candidates, preset);
  let payload: RankPayload | null = null;
  let coverage = 0;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      prompt += `\n\n上一次输出覆盖率不足（ranked 数组缺少候选）。本次必须返回全部 ${candidates.length} 个候选的排序结果——ranked 数组长度必须等于 ${candidates.length}，每个 code 必须与下方候选列表完全一致，不得遗漏任何一个，不得编造候选池外的代码。`;
    }
    let raw: string;
    try {
      raw = await callLlm(prompt, cfg);
    } catch (e: any) {
      degradation.push(`llm_call_failed:${e.message}`);
      return fallback(picks, preset, degradation, `LLM 调用失败：${e.message}`);
    }
    if (!raw.trim()) {
      degradation.push('empty_response');
      continue;
    }
    payload = parseJsonLenient(raw);
    if (!payload) {
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
