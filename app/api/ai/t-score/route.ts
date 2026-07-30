/**
 * POST /api/ai/t-score — 波段评分 LLM 微调
 *
 * 客户端已算好确定性 buyScore/sellScore，本路由只做：LLM 调用(非流式) → 容错 JSON 解析
 * → 覆盖率门控 + 1 重试 → ±15 有界融合 → 合规后处理。失败优雅降级回退纯因子分。
 * 镜像 services/ai-screen/ranker.ts 的 callLlm/parseJsonLenient 模式，但不排序、单对象。
 */

import { NextRequest, NextResponse } from 'next/server';
import { buildChatUrl, buildLLMHeaders, createTimeoutSignal } from '@/lib/llm-client';
import { formatAiError, formatNetworkError } from '@/lib/ai-error';

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

async function callLlm(systemPrompt: string, userPrompt: string, cfg: { baseUrl: string; apiKey?: string; model: string }): Promise<string> {
  const url = buildChatUrl(cfg.baseUrl);
  const headers = buildLLMHeaders(cfg.apiKey);
  const { signal, clear } = createTimeoutSignal(LLM_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.2,
        max_tokens: LLM_MAX_TOKENS,
        stream: false,
      }),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(formatAiError(res.status, text));
    }
    const data = await res.json();
    return data?.choices?.[0]?.message?.content ?? '';
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    const isAbort = err.name === 'AbortError' || /abort/i.test(err.message);
    if (isAbort) throw new Error('LLM 微调超时（60s）');
    throw new Error(formatNetworkError(err));
  } finally {
    clear();
  }
}

interface TscoreRequestBody {
  systemPrompt: string;
  userPrompt: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  buyScore: number;
  sellScore: number;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as TscoreRequestBody;
    const { systemPrompt, userPrompt, baseUrl, apiKey, model, buyScore, sellScore } = body;
    if (!baseUrl || !model) {
      return NextResponse.json({ error: '缺少必要参数: baseUrl, model' }, { status: 400 });
    }
    const cfg = { baseUrl, apiKey, model };
    const degradation: string[] = [];

    let payload: TscorePayload | null = null;
    let coverage = 0;
    let raw = '';

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        raw = await callLlm(
          attempt === 0 ? systemPrompt : systemPrompt + '\n\n上一次输出未满足结构化要求，请重新返回严格 JSON。',
          userPrompt, cfg,
        );
      } catch (e) {
        degradation.push(`llm_call_failed:${e instanceof Error ? e.message : String(e)}`);
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

    if (!payload || coverage < MIN_COVERAGE) {
      degradation.push(`coverage_below_threshold:${coverage.toFixed(2)}`);
      return fallback(buyScore, sellScore, degradation, 'LLM 覆盖率不足');
    }

    const buyAdjust = boundedFloat(payload.buy_adjust, -15, 15, 0);
    const sellAdjust = boundedFloat(payload.sell_adjust, -15, 15, 0);
    const finalBuy = Math.round(clamp(buyScore + buyAdjust));
    const finalSell = Math.round(clamp(sellScore + sellAdjust));

    return NextResponse.json({
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
    });
  } catch (e) {
    console.error('[api/ai/t-score]', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : '波段评分失败' }, { status: 500 });
  }
}

function fallback(buyScore: number, sellScore: number, degradation: string[], reason: string) {
  return NextResponse.json({
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
  });
}
