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
const MAX_RETRIES = 1;
// 非流式单层超时：覆盖中转慢生成整段耗时（07-30 非流式 90s 曾超时，放宽到 300s）
const LLM_TIMEOUT_MS = 300_000;
// 轻量化（08-05）：输出字段 12→8（后恢复 tags/watch_items/invalidators 到 11，保住 UI 跟踪/证伪点与复盘 tag 维度）+ 输入字段瘦身后，正文 ≈2k token。
// max_tokens 对思考型模型 = 思考+正文总预算，卡太紧会"思考烧光→正文截断→解析失败→降级纯规则"。
// 12288 = 2k 正文 + 10k 思考余量：保住思考深度不撞线，真实花费仍随输入/输出瘦身降 ~40%。
// 中转若把 max_tokens 卡得更小会 400，callLlm 内自动降级重试 4096。
const LLM_MAX_TOKENS = 12288;
// 单批送 LLM 的候选数上限：prompt 长度与 max_tokens 的甜点（08-05 审计后定 20，08-11 提到 30）。
// 全池重排由 rankAllCandidates 分批调用（批间 sleep 防限流），本上限只管单批。
const LLM_TOPK_CAP = 30;
// 批量间隔：每日调度时间换空间，防 DeepSeek 限流
const BATCH_DELAY_MS = 3000;

export interface RankResult {
  picks: AiPick[];
  llmRanked: boolean;
  /** topK 内全部候选都有 LLM 分（整体完成，可置 llmReranked=true 共享缓存） */
  completed: boolean;
  /** 本次请求匹配到的候选数（失败但 >0 时表示部分结果已保留） */
  matched: number;
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
      // 400 且错误含 max_tokens 字样（厂商卡上限）→ 用 4096 重试，避免把「可降级」变成「调用失败」
      if (/400|max[_ -]?tokens?|max completion/i.test(msg)) {
        data = (await post(4096)) as ChatCompletionResponse;
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

  // 未被 LLM 命中的候选：llmScore 保持 null，final 用纯规则分（08-05：AI 未覆盖 ≠ AI 看空，
  // 不编造兜底分——与池外候选同一约定"AI 没介入 = 按规则分"）

  // 融合：llmScore 有值才混合 AI 意见；未覆盖（或池外）的保持规则分
  for (const k of picks) {
    k.finalScore = k.llmScore != null
      ? k.screenScore * (1 - RANK_WEIGHT) + k.llmScore * RANK_WEIGHT
      : k.screenScore;
  }
  return { matched, degradation };
}

/**
 * LLM 重排主入口（增量续打版）。
 * - 只对 topK 内"缺分"的候选发起请求；已打分候选作为标尺参照附在 prompt（防标尺漂移）
 * - 无论成败，本次匹配到的分数都会回填到 picks（部分保留：失败不丢分）
 * - llmRanked=true 表示本次请求覆盖达标；completed=true 表示 topK 全部有分（可共享缓存）
 * - 失败路径保留历史已有分（llmScore 不清空），供后续用户增量续打
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

  // 送 LLM 的候选数 = min(maxOutput, TOPK)。与 maxOutput 对齐（08-05 审计后从 15 恢复）：池尾不再有"展示但无 LLM 介入"的断层
  const topK = Math.min(LLM_TOPK_CAP, picks.length);
  const sortedByScreen = [...picks].sort((a, b) => b.screenScore - a.screenScore);
  const candidates = sortedByScreen.slice(0, topK);
  const candidateMap = new Map(candidates.map((k) => [normalizeCode(k.tsCode), k]));
  // 池外候选先按规则分排好，作为 LLM 命中后的尾部
  const rest = picks.filter((k) => !candidateMap.has(normalizeCode(k.tsCode))).sort((a, b) => b.screenScore - a.screenScore);

  // 增量续打：已打分候选作标尺参照，本次只送缺分的
  const alreadyScored = candidates
    .filter((k) => k.llmScore != null)
    .map((k) => ({ code: normalizeCode(k.tsCode), name: k.name, llmScore: k.llmScore! }));
  const toScore = candidates.filter((k) => k.llmScore == null);

  // 全部已有分（防御性，历史数据异常时）→ 无需 LLM，直接完成排序
  if (toScore.length === 0) {
    for (const k of candidates) {
      k.finalScore = k.llmScore != null
        ? k.screenScore * (1 - RANK_WEIGHT) + k.llmScore * RANK_WEIGHT
        : k.screenScore;
    }
    for (const k of rest) k.finalScore = k.screenScore;
    const merged = [...candidates, ...rest].sort((a, b) => b.finalScore - a.finalScore);
    merged.forEach((k, i) => (k.rank = i + 1));
    return {
      picks: merged,
      llmRanked: true,
      completed: true,
      matched: toScore.length,
      marketView: '',
      selectionLogic: '',
      portfolioRisk: '',
      coverage: 1,
      degradation: [...degradation, 'all_scored'],
    };
  }

  let prompt = buildRankingPrompt(toScore, preset, '', alreadyScored);
  let payload: RankPayload | null = null;
  let coverage = 0;
  let matched = 0;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      prompt += `\n\n上一次输出不是合法 JSON 或 ranked 数组缺少候选。本次必须只返回严格 JSON：ranked 数组长度必须等于 ${toScore.length}，每个 code 必须与下方候选列表完全一致，不得遗漏任何一个，不得编造候选池外的代码。`;
    }
    let result: LlmTextResult;
    try {
      result = await callLlm(prompt, cfg);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      degradation.push(`llm_call_failed:${msg}`);
      return partialResult(candidates, rest, degradation, `LLM 调用失败：${msg}`);
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
      console.error(`[ai-screen/ranker] json_parse_failed attempt${attempt + 1}/${MAX_RETRIES + 1} candidates=${toScore.length}:`, JSON.stringify(raw.slice(0, 300)));
      degradation.push('json_parse_failed');
      continue;
    }
    // 总是回填已匹配部分（部分保留核心：失败也不丢分）
    const { matched: m, degradation: dg } = applyRanking(toScore, payload);
    degradation.push(...dg);
    matched = m;
    coverage = matched / Math.max(toScore.length, 1);
    if (coverage >= MIN_COVERAGE) break;
    degradation.push(`low_coverage:${coverage.toFixed(2)}@attempt${attempt + 1}`);
  }

  if (!payload || coverage < MIN_COVERAGE) {
    // 失败但已保留部分匹配（或历史分）→ 按当前分数排序返回，llmRanked=false，后续可续打
    degradation.push(`coverage_below_threshold:${coverage.toFixed(2)}`);
    return partialResult(candidates, rest, degradation, 'LLM 覆盖率不足');
  }

  // 本次成功：融合已含全部有分候选（历史分 + 本次新分），全局字段取 payload
  for (const k of candidates) {
    k.finalScore = k.llmScore != null
      ? k.screenScore * (1 - RANK_WEIGHT) + k.llmScore * RANK_WEIGHT
      : k.screenScore;
  }
  // 池外候选：final = screen_score（llm 未介入）
  for (const k of rest) k.finalScore = k.screenScore;

  const merged = [...candidates, ...rest].sort((a, b) => b.finalScore - a.finalScore);
  merged.forEach((k, i) => (k.rank = i + 1));

  return {
    picks: merged,
    llmRanked: true,
    completed: toScore.every((k) => k.llmScore != null),
    matched,
    marketView: safeText(payload!.market_view, 260),
    selectionLogic: safeText(payload!.selection_logic, 360),
    portfolioRisk: safeText(payload!.portfolio_risk, 360),
    coverage,
    degradation,
  };
}

/**
 * 失败/部分结果路径：保留所有已有 LLM 分（历史分 + 本次回填），按当前分数排序返回。
 * 不清空 llmScore——部分保留是增量续打的基石。
 */
function partialResult(candidates: AiPick[], rest: AiPick[], degradation: string[], reason: string): RankResult {
  for (const k of candidates) {
    k.finalScore = k.llmScore != null
      ? k.screenScore * (1 - RANK_WEIGHT) + k.llmScore * RANK_WEIGHT
      : k.screenScore;
    k.rank = 0;
  }
  for (const k of rest) k.finalScore = k.screenScore;
  const merged = [...candidates, ...rest].sort((a, b) => b.finalScore - a.finalScore);
  merged.forEach((k, i) => (k.rank = i + 1));
  degradation.push(`partial_kept:${reason}`);
  return {
    picks: merged,
    llmRanked: false,
    completed: false,
    matched: 0,
    marketView: '',
    selectionLogic: '',
    portfolioRisk: '',
    coverage: null,
    degradation,
  };
}

function emptyFallback(picks: AiPick[], _preset: StrategyPreset, degradation: string[]): RankResult {
  const sorted = [...picks].sort((a, b) => b.screenScore - a.screenScore);
  for (const k of sorted) k.finalScore = k.screenScore;
  sorted.forEach((k, i) => (k.rank = i + 1));
  return {
    picks: sorted,
    llmRanked: false,
    completed: false,
    matched: 0,
    marketView: '',
    selectionLogic: '',
    portfolioRisk: '',
    coverage: null,
    degradation,
  };
}

/**
 * 全池重排（每日调度用，时间换空间）：
 * 按 screenScore 降序分批送 LLM（每批 ≤ LLM_TOPK_CAP，批间 sleep 防限流）。
 * 第一批的 marketView/selectionLogic/portfolioRisk 作为整体观点沿用。
 * 任何一批失败/解析失败 → 该批保留规则分，后续批次继续（不熔断——每日任务不赶时间）。
 */
export async function rankAllCandidates(
  picks: AiPick[],
  preset: StrategyPreset,
  cfg: LlmConfig,
  preScored?: Map<string, AiPick>, // 跨 run 断点续打：旧 run 已有 LLM 分的候选，作标尺 + 免重打
): Promise<RankResult> {
  // 回填旧 run 已有分（新 run 候选未打分的才补；已打分的候选 rankCandidates 会当标尺参照）
  if (preScored) {
    for (const k of picks) {
      const s = preScored.get(k.tsCode);
      if (s && k.llmScore == null) {
        k.llmScore = s.llmScore; k.llmConfidence = s.llmConfidence;
        k.llmSector = s.llmSector; k.llmTheme = s.llmTheme; k.llmThesis = s.llmThesis;
        k.rankingReason = s.rankingReason; k.riskSummary = s.riskSummary;
        k.llmCatalysts = s.llmCatalysts; k.llmRisks = s.llmRisks; k.llmTags = s.llmTags;
        k.llmStyleFit = s.llmStyleFit; k.llmWatchItems = s.llmWatchItems; k.llmInvalidators = s.llmInvalidators;
      }
    }
  }
  if (picks.length <= LLM_TOPK_CAP) return rankCandidates(picks, preset, cfg);

  const sorted = [...picks].sort((a, b) => b.screenScore - a.screenScore);
  const batches: AiPick[][] = [];
  for (let i = 0; i < sorted.length; i += LLM_TOPK_CAP) batches.push(sorted.slice(i, i + LLM_TOPK_CAP));

  let marketView = '', selectionLogic = '', portfolioRisk = '';
  let anyRanked = false;
  const degradation: string[] = [];
  let totalMatched = 0;

  for (let bi = 0; bi < batches.length; bi++) {
    const r = await rankCandidates(batches[bi], preset, cfg);
    totalMatched += r.matched;
    if (r.llmRanked) anyRanked = true;
    if (bi === 0) {
      marketView = r.marketView;
      selectionLogic = r.selectionLogic;
      portfolioRisk = r.portfolioRisk;
    }
    degradation.push(...r.degradation.map((d) => `batch${bi + 1}:${d}`));
    if (bi < batches.length - 1) await new Promise((res) => setTimeout(res, BATCH_DELAY_MS));
  }

  // 合并后按 finalScore 整体排序（各批次的 finalScore 已各自算好，标尺是全局 screenScore 混入，跨批可比）
  const merged = batches.flat().sort((a, b) => b.finalScore - a.finalScore);
  merged.forEach((k, i) => (k.rank = i + 1));
  const withScore = merged.filter((k) => k.llmScore != null).length;

  return {
    picks: merged,
    llmRanked: anyRanked,
    completed: withScore === merged.length,
    matched: totalMatched,
    marketView,
    selectionLogic,
    portfolioRisk,
    coverage: merged.length ? withScore / merged.length : null,
    degradation,
  };
}
