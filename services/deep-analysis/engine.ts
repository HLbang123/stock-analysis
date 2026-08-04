/**
 * 深度分析 — 三阶段(情报→辩论→裁决)的数据准备、SSE 流解析与结果落库。
 * 从 app/ai/page.tsx 抽出，页面只保留编排与状态。
 */

import type { RealtimeQuote } from '@/types';
import type { Stock } from '@/types';
import type { AiAnalysisRecord } from '@/store/ai-store';
import type { TradeLevels, MarketRegime } from '@/services/deep-analysis/levels';
import type { ChipDistribution } from '@/lib/chip';
import type { LlmConfig } from '@/services/ai-screen/types';
import {
  buildAnalystSystemPrompt, buildAnalystUserPrompt,
  buildVerdictSystemPrompt, buildVerdictUserPrompt,
  buildReflectionContext, buildDebateDataPrompt,
} from '@/services/deepAnalysisPrompt';
import { computeKeyLevels, formatLevelsForPrompt } from '@/services/deep-analysis/levels';
import { calculateIndicators, formatIndicatorsForPrompt } from '@/lib/indicators';
import { buildUpdatedKLines } from '@/lib/stock-helpers';
import { checkAllRules, ALERT_RULES } from '@/services/alertRules';
import { getIndustry, getRealtimeQuoteCached, getKLineSinaCached, getChipData, fetchMarketStatusNote } from '@/services/stockApi';
import { fetchTushareData, formatTushareForPrompt } from '@/services/tushareData';
import { getJSONOr, postJSON } from '@/services/api';
import type { StockRpsResp, BreadthResp, FuyaoFundResp } from '@/types/api';
import { isETF } from '@/lib/identify';

// ── 结构化裁决结果（verdict 文本解析）─────────────────────────────────
export interface DeepStructured {
  action: string;
  oneLiner?: string;
  riskLevel: string;
  confidence: number;
  targetLow: number;
  targetHigh: number;
  stopLoss: number;
  position: number;
  reasoning: string;
  plan: string;
  riskNote: string;
  confidenceScore?: number;
  clamped?: string[];
  keyPoints?: string[];
}

export interface DeepLevels {
  current: number;
  supports: { price: number; label: string }[];
  resistances: { price: number; label: string }[];
}

export interface DeepResult {
  analyst: string;
  analystReasoning?: string;
  debate: string;
  debateReasoning?: string;
  debateError?: string;
  verdict: string;
  verdictReasoning?: string;
  verdictError?: string;
  levels?: DeepLevels | null;
  structured: DeepStructured | null;
}

export type DeepStage = 'idle' | 'analyst' | 'debate' | 'verdict';

export interface DeepProgress {
  stage: DeepStage;
  result: DeepResult;
}

/** 解析 verdict 文本为结构化字段；levels 传入时对目标价/止损/仓位做越界夹紧 */
export function parseVerdictContent(text: string, levels?: TradeLevels | null): DeepStructured {
  const actionMatch = text.match(/ACTION:(.+)/);
  const oneLinerMatch = text.match(/ONE_LINER:(.+)/);
  const riskMatch = text.match(/RISK_LEVEL:(.+)/);
  const confMatch = text.match(/CONFIDENCE:\s*(\d+)/);
  const confValue = confMatch ? parseInt(confMatch[1]) : 0;
  const confScoreValue = confValue / 100;
  const targetLowMatch = text.match(/TARGET_LOW:(.+)/);
  const targetHighMatch = text.match(/TARGET_HIGH:(.+)/);
  const stopMatch = text.match(/STOP_LOSS:(.+)/);
  const posMatch = text.match(/POSITION:(.+)/);
  const keyPointsMatch = text.match(/KEY_POINTS:\s*(.+)/);

  const bodySplit = text.split(/^---[\r\n]+/m);
  let body = bodySplit.length > 1 ? bodySplit.slice(1).join('---\n') : text;
  body = body.replace(/^(ONE_LINER|ACTION|RISK_LEVEL|CONFIDENCE(_SCORE)?|TARGET_LOW|TARGET_HIGH|STOP_LOSS|POSITION|KEY_POINTS):.*$/gm, '').replace(/\n{3,}/g, '\n\n').trim();

  let reasoning = body, plan = '', riskNote = '';
  const planIdx = body.indexOf('### 操作计划');
  const riskIdx = body.indexOf('### 风险提示');
  if (planIdx >= 0) {
    reasoning = body.slice(0, planIdx).replace(/^###\s*决策理由\s*\n?/m, '').trim();
    if (riskIdx >= 0) {
      plan = body.slice(planIdx, riskIdx).replace(/^###\s*操作计划\s*\n?/m, '').trim();
      riskNote = body.slice(riskIdx).replace(/^###\s*风险提示\s*\n?/m, '').trim();
    } else {
      plan = body.slice(planIdx).replace(/^###\s*操作计划\s*\n?/m, '').trim();
    }
  } else {
    reasoning = body.replace(/^###\s*决策理由\s*\n?/m, '').trim();
  }

  const clamped: string[] = [];
  const toNum = (raw: string | undefined): number => {
    const v = parseFloat((raw || '').replace(/[^\d.]/g, ''));
    return Number.isFinite(v) ? v : NaN;
  };
  const clamp = (v: number, lo: number, hi: number, label: string): number => {
    if (!Number.isFinite(v)) return lo;
    if (v < lo) { clamped.push(`${label}:${v.toFixed(2)}→${lo.toFixed(2)}`); return lo; }
    if (v > hi) { clamped.push(`${label}:${v.toFixed(2)}→${hi.toFixed(2)}`); return hi; }
    return v;
  };

  const tR = levels?.targetRange, sR = levels?.stopLossRange, pR = levels?.positionRange;
  const targetLow = tR ? clamp(toNum(targetLowMatch?.[1]), tR.low, tR.high, 'target_low') : toNum(targetLowMatch?.[1]);
  const targetHigh = tR ? clamp(toNum(targetHighMatch?.[1]), tR.low, tR.high, 'target_high') : toNum(targetHighMatch?.[1]);
  const stopLoss = sR ? clamp(toNum(stopMatch?.[1]), sR.low, sR.high, 'stop_loss') : toNum(stopMatch?.[1]);
  const position = pR ? clamp(toNum(posMatch?.[1]), pR.low, pR.high, 'position') : toNum(posMatch?.[1]);

  return {
    action: actionMatch?.[1]?.trim() || '',
    oneLiner: oneLinerMatch?.[1]?.trim() || '',
    riskLevel: riskMatch?.[1]?.trim() || '',
    confidence: parseInt(confMatch?.[1]?.trim() || '0'),
    targetLow, targetHigh, stopLoss, position,
    reasoning, plan, riskNote,
    confidenceScore: confScoreValue,
    clamped,
    keyPoints: keyPointsMatch ? keyPointsMatch[1].split('|').map(p => p.trim()).filter(p => p.length > 0) : [],
  };
}

// ── 数据准备（抓行情/K线/筹码 + 算指标 + 拼三阶段 prompt）──────────────
export interface DeepContext {
  stage1: { systemPrompt: string; userPrompt: string };
  stage2: { systemPrompt: string; userPrompt: string };
  stage3: { systemPrompt: string; userPrompt: string };
  tradeLevels: TradeLevels;
  marketRegime: MarketRegime;
  tushareIssues: string[];
  entryDate: string;
  quote: RealtimeQuote;
}

export async function prepareDeepContext(
  selectedCode: string,
  stock: Stock,
  history: AiAnalysisRecord[],
): Promise<DeepContext> {
  const [quote, kLines, tushareData, rpsRes, breadthRes] = await Promise.all([
    getRealtimeQuoteCached(selectedCode),
    getKLineSinaCached(selectedCode, 240, 120),
    fetchTushareData(selectedCode).catch(async () => {
      await new Promise(r => setTimeout(r, 2000));
      return fetchTushareData(selectedCode).catch(() => null);
    }),
    getJSONOr<StockRpsResp | null>(`/api/stock/rps?code=${selectedCode}`, null),
    getJSONOr<BreadthResp | null>('/api/market/breadth?days=1', null),
  ]);

  if (!quote) throw new Error('获取行情失败');

  // 市场状态判定（仓位联动）：breadth 最新日涨跌比 + 站上55日线比例
  const breadthLatest = breadthRes?.items?.[0];
  let marketRegime: MarketRegime = 'neutral';
  if (breadthLatest) {
    const ad = (breadthLatest.advance || 0) + (breadthLatest.decline || 0);
    const adRatio = ad > 0 ? (breadthLatest.advance || 0) / ad : 0.5;
    const aboveRatio = typeof breadthLatest.aboveMa55Ratio === 'number' ? breadthLatest.aboveMa55Ratio : 0.5;
    const score = adRatio * 0.5 + aboveRatio * 0.5;
    marketRegime = score >= 0.6 ? 'strong' : score <= 0.4 ? 'weak' : 'neutral';
  }

  const tushareIssues = [...(tushareData?.errors || []), ...(tushareData?.warnings || [])];
  const tushareBlock = formatTushareForPrompt(tushareData);

  const updatedKLines = kLines.length >= 5 ? buildUpdatedKLines(quote, kLines) : kLines;
  const chip: ChipDistribution | null = await getChipData(selectedCode).catch(() => null);
  const engineResults = checkAllRules(updatedKLines, quote, ALERT_RULES.filter(r => r.isEnabled), chip);
  const engineSummary = engineResults.length > 0
    ? engineResults.map(r => `${r.ruleId}:${r.message}`).join('; ')
    : '未触发任何破位/死叉/急跌等风险信号，技术面健康';

  const chipNote = chip
    ? `[筹码分布]\n主峰价位: ${chip.dominantPeak} | 平均成本: ${chip.avgCost} | 获利盘: ${(chip.profitRatio * 100).toFixed(1)}% | 90%集中度: ${chip.concentration90.toFixed(3)}（越小越密集） | 峰位相对位置: ${chip.peakPos.toFixed(3)}（站上主峰为正） | 5日峰位漂移: ${chip.peakDrift.toFixed(3)}（下移为吸筹）\n（筹码形态仅供参考，需结合趋势与量能综合判断）\n\n`
    : '';

  const quoteJson = JSON.stringify(quote, null, 2);
  const klineSummary = kLines.slice(-60).map(k => `${k.date} ${k.open} ${k.high} ${k.low} ${k.close} ${k.volume}`).join('\n');
  const klineSummary20 = kLines.slice(-20).map(k => `${k.date} ${k.open} ${k.high} ${k.low} ${k.close} ${k.volume}`).join('\n');

  const indicatorResult = calculateIndicators(updatedKLines);
  const indicatorBlock = formatIndicatorsForPrompt(indicatorResult);

  const tradeLevels = computeKeyLevels({
    kLines: updatedKLines,
    indicators: indicatorResult,
    chip,
    engineResults,
    quote,
    rps250: rpsRes && !rpsRes.error ? (rpsRes.rps250 ?? null) : null,
    positionPercent: stock.positionPercent,
    marketRegime,
  });
  const levelsText = formatLevelsForPrompt(tradeLevels);

  const reflectionBlock = buildReflectionContext(selectedCode, history, { price: quote.price, changePercent: quote.changePercent });

  const positionNote = stock.positionPercent !== undefined
    ? `注意：该股票占用户总持仓的${stock.positionPercent}%，请在分析中考虑仓位集中度风险。`
    : undefined;
  const positionNoteVerdict = stock.positionPercent !== undefined
    ? `用户当前持仓占比为${stock.positionPercent}%，请在仓位建议中考虑现有持仓，如需减持请明确说明。`
    : undefined;

  const marketStatusNote = `[市场状态] ${await fetchMarketStatusNote()}\n\n`;
  const rpsNote = rpsRes && !rpsRes.error
    ? `[RPS强度] 20日:${rpsRes.rps20?.toFixed(1)} 60日:${rpsRes.rps60?.toFixed(1)} 120日:${rpsRes.rps120?.toFixed(1)} 250日:${rpsRes.rps250?.toFixed(1)}（${(rpsRes.rps250 ?? 0) >= 95 ? '全市场前5%极强' : (rpsRes.rps250 ?? 0) >= 87 ? '强势' : '中等偏弱'}）\n\n`
    : '';
  const etf = isETF(selectedCode);
  let etfHoldingsNote = '';
  if (etf) {
    const em = selectedCode.match(/^([a-z]+)(\d+)$/i);
    if (em) {
      const thscode = `${em[2]}.${em[1].toUpperCase()}`;
      const fundRes = await getJSONOr<FuyaoFundResp | null>(`/api/fuyao/fund?code=${thscode}`, null);
      if (fundRes?.holdings && fundRes.holdings.length > 0) {
        etfHoldingsNote = `[基金持仓] 前${fundRes.holdings.length}大重仓股：${fundRes.holdings.map((h: any) => `${h.stock_name}(${h.hold_ratio.toFixed(1)}%)`).join('、')}\n\n`;
      }
    }
  }

  const stage1 = {
    systemPrompt: buildAnalystSystemPrompt(etf),
    userPrompt: marketStatusNote + rpsNote + etfHoldingsNote + chipNote + buildAnalystUserPrompt(selectedCode, stock.name, quoteJson, klineSummary, engineSummary, indicatorBlock, reflectionBlock, positionNote, etf, tushareBlock, getIndustry(selectedCode)),
  };
  const stage2 = {
    systemPrompt: '',
    userPrompt: buildDebateDataPrompt(selectedCode, stock.name, quoteJson, indicatorBlock, marketStatusNote, engineSummary, klineSummary20, chipNote),
  };
  const compactQuote = `当前价 ${quote.price} 元，涨跌 ${quote.changePercent.toFixed(2)}%（昨收 ${quote.preClose}，开盘 ${quote.open}，最高 ${quote.high}，最低 ${quote.low}）`;
  const stage3 = {
    systemPrompt: buildVerdictSystemPrompt(),
    userPrompt: buildVerdictUserPrompt(selectedCode, stock.name, '', '', compactQuote, positionNoteVerdict, engineSummary, levelsText),
  };

  const entryDate = breadthLatest?.date || (rpsRes as any)?.calcDate || new Date().toISOString().slice(0, 10).replace(/-/g, '');

  return { stage1, stage2, stage3, tradeLevels, marketRegime, tushareIssues, entryDate, quote };
}

// ── SSE 流式调用 + 解析 ─────────────────────────────────────────────
export interface RunDeepOptions {
  ctx: DeepContext;
  cfg: LlmConfig;
  resumeCompleted?: Record<string, string>;
  userView?: string;
  userViewReason?: string;
  signal: AbortSignal;
  onProgress: (p: DeepProgress) => void;
}

export interface RunDeepOutcome {
  result: DeepResult;
  completedMap: Record<string, string>;
}

export async function runDeepAnalysisStream(opts: RunDeepOptions): Promise<RunDeepOutcome> {
  const { ctx, cfg, resumeCompleted, userView, userViewReason, signal, onProgress } = opts;

  const res = await fetch('/api/ai/deep-analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      stage1: ctx.stage1, stage2: ctx.stage2, stage3: ctx.stage3,
      baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model,
      completed: resumeCompleted,
      userView: userView || undefined,
      userViewReason: userViewReason || undefined,
    }),
    signal,
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(errData.error || 'API请求失败');
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  let analystText = '', analystReasoning = '';
  let debateText = '', debateReasoning = '', debateError = '';
  let verdictText = '', verdictReasoning = '', verdictError = '';
  const completedMap: Record<string, string> = {};
  let stage: DeepStage = 'idle';

  const emit = (structured?: DeepStructured | null) => {
    onProgress({
      stage,
      result: {
        analyst: analystText,
        analystReasoning: analystReasoning || undefined,
        debate: debateText,
        debateReasoning: debateReasoning || undefined,
        debateError: debateError || undefined,
        verdict: verdictText,
        verdictReasoning: verdictReasoning || undefined,
        verdictError: verdictError || undefined,
        levels: { current: ctx.tradeLevels.currentPrice, supports: ctx.tradeLevels.supports, resistances: ctx.tradeLevels.resistances },
        structured: structured ?? null,
      },
    });
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    sseBuffer += decoder.decode(value, { stream: true });
    const lines = sseBuffer.split('\n');
    sseBuffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') continue;

      try {
        const msg = JSON.parse(data);
        if (msg.error && !msg.stage) throw new Error(msg.error);

        if (msg.stage === 'analyst') {
          if (msg.text !== undefined) { analystText += msg.text; stage = 'analyst'; emit(); }
          if (msg.reasoning) { analystReasoning += msg.reasoning; emit(); }
          if (msg.done) completedMap.analyst = analystText;
        }
        if (msg.stage === 'debate') {
          if (msg.role && msg.text !== undefined) completedMap[msg.role] = msg.text.replace(/\n+$/, '');
          if (msg.text !== undefined) { debateText += msg.text; stage = 'debate'; emit(); }
          if (msg.reasoning) { debateReasoning += msg.reasoning; emit(); }
          if (msg.error) { debateError = msg.error; emit(); }
        }
        if (msg.stage === 'verdict') {
          if (msg.text !== undefined) {
            verdictText += msg.text;
            stage = 'verdict';
            emit(parseVerdictContent(verdictText, ctx.tradeLevels));
          }
          if (msg.reasoning) { verdictReasoning += msg.reasoning; emit(); }
          if (msg.done) completedMap.verdict = verdictText;
          if (msg.error) { verdictError = msg.error; emit(); }
        }
      } catch (e: any) {
        if (e.message && !e.message.includes('JSON')) throw e;
      }
    }
  }

  const finalStructured = parseVerdictContent(verdictText, ctx.tradeLevels);
  return {
    result: {
      analyst: analystText,
      analystReasoning: analystReasoning || undefined,
      debate: debateText,
      debateReasoning: debateReasoning || undefined,
      debateError: debateError || undefined,
      verdict: verdictText,
      verdictReasoning: verdictReasoning || undefined,
      verdictError: verdictError || undefined,
      levels: { current: ctx.tradeLevels.currentPrice, supports: ctx.tradeLevels.supports, resistances: ctx.tradeLevels.resistances },
      structured: finalStructured,
    },
    completedMap,
  };
}

// ── 历史摘要组装 + 全局回测落库 ─────────────────────────────────────
export function buildDeepSummary(result: DeepResult): string {
  let debateConclusion = '';
  const debateMatch = result.debate.match(/【综合评判】([\s\S]*?)(?=\n【|\n###|\n$|$)/);
  if (debateMatch) debateConclusion = debateMatch[1].trim();

  const parts: string[] = [];
  if (debateConclusion) parts.push(`📊 综合评判：${debateConclusion}`);
  if (result.structured?.action) {
    parts.push(`⚖️ 最终决策：${result.structured.action} | 风险${result.structured.riskLevel} | 信心${result.structured.confidence}%`);
  }
  if (result.structured?.reasoning) parts.push(`📝 ${result.structured.reasoning}`);
  return parts.join('\n\n') || result.analyst.slice(0, 500).trim();
}

export function buildDeepSuggestion(structured: DeepStructured | null): string {
  if (!structured?.action) return '见详细报告';
  return `仓位:${Number.isFinite(structured.position) ? structured.position.toFixed(0) : '--'}% | 目标:${Number.isFinite(structured.targetLow) ? structured.targetLow.toFixed(2) : '--'}-${Number.isFinite(structured.targetHigh) ? structured.targetHigh.toFixed(2) : '--'} | 止损:${Number.isFinite(structured.stopLoss) ? structured.stopLoss.toFixed(2) : '--'}`;
}

/** 全局回测落库（匿名，按 股票+交易日+建议 去重；失败静默） */
export async function saveDeepEval(params: {
  stockCode: string; stockName: string; entryDate: string; entryPrice: number;
  structured: DeepStructured | null;
}): Promise<void> {
  const { structured } = params;
  try {
    await postJSON('/api/ai/deep-eval', {
      stockCode: params.stockCode, stockName: params.stockName,
      entryDate: params.entryDate, entryPrice: params.entryPrice,
      action: structured?.action,
      targetLow: structured && Number.isFinite(structured.targetLow) ? structured.targetLow : null,
      targetHigh: structured && Number.isFinite(structured.targetHigh) ? structured.targetHigh : null,
      stopLoss: structured && Number.isFinite(structured.stopLoss) ? structured.stopLoss : null,
      position: structured && Number.isFinite(structured.position) ? structured.position : null,
      confidence: structured?.confidence,
      reasoning: structured?.reasoning,
    });
  } catch {
    // 回测落库失败不阻断分析
  }
}
