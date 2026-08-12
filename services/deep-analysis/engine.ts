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
  buildTechR1SystemPrompt, buildRiskR1SystemPrompt, buildXinJieR1DebatePrompt,
  buildTechR2RebuttalPrompt, buildRiskR2RebuttalPrompt, buildXinJieR2RebuttalPrompt,
} from '@/services/deepAnalysisPrompt';
import { computeKeyLevels, formatLevelsForPrompt } from '@/services/deep-analysis/levels';
import { calculateIndicators, formatIndicatorsForPrompt } from '@/lib/indicators';
import { buildUpdatedKLines, beijingTodayStr } from '@/lib/stock-helpers';
import { checkAllRules, ALERT_RULES } from '@/services/alertRules';
import { getIndustry, getRealtimeQuoteCached, getKLineSinaCached, getChipData, fetchMarketStatusNote, getMarketIndexQuotes, type MarketIndexQuote } from '@/services/stockApi';
import { fetchTushareDataCached, formatTushareForPrompt } from '@/services/tushareData';
import { getJSONOr, postJSON, getJSON } from '@/services/api';
import { streamChatDirect, LlmHttpError, isDirectConnectionError } from '@/services/llm/browser-client';
import { acquireLlmSlot, noteLlmRateLimited } from './concurrency';
import type { StockRpsResp, BreadthResp, FuyaoFundResp } from '@/types/api';
import { isETF } from '@/lib/identify';

// ── 结构化裁决结果（verdict 文本解析）─────────────────────────────────
export interface DeepStructured {
  action: string;
  oneLiner?: string;
  /** 综合评判（原 manager 职责并入裁决：对比辩论三人论点 + 5级情绪强度 + 是否改变初判） */
  consensus?: string;
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
  /** 并行编排后阶段指示不再单调，卡片游标/思考面板据此判断该区是否仍在流式写入 */
  analystDone?: boolean;
  debateDone?: boolean;
  /** 本次分析降级说明（上游角色失败被跳过 / 裁决降级 / 规则兜底）——UI 展示给用户知道分析不完整 */
  warnings?: string[];
}

export type DeepStage = 'idle' | 'analyst' | 'debate' | 'verdict';

export interface DeepProgress {
  stage: DeepStage;
  result: DeepResult;
}

/** 归一化 ACTION 输出：剥离 markdown/括号等杂讯，把常见变体映射到 买入/持有/卖出 三选一
 *  LLM 偶发输出 `** 持有`、`观望`、`（买入）` 等，直接落库会污染方向胜率榜分组 */
export function normalizeAction(raw: string | undefined): string {
  const s = (raw || '').replace(/[*_`~]/g, '').replace(/[（）()]/g, '').trim();
  if (!s) return '';
  if (/买入|看多|增持|低吸/.test(s)) return '买入';
  if (/卖出|看空|减仓|清仓|减持|高抛/.test(s)) return '卖出';
  if (/持有|观望|不动|拿住|持仓/.test(s)) return '持有';
  return s; // 无法识别保留原文，便于后续排查而非误归类
}

/** 解析 verdict 文本为结构化字段；levels 传入时对目标价/止损/仓位做越界夹紧 */
export function parseVerdictContent(text: string, levels?: TradeLevels | null): DeepStructured {
  // 综合评判在字段区之前（prompt 要求先写），捕获到第一个 KEY: 行为止
  const consensusMatch = text.match(/【综合评判】\s*([\s\S]*?)(?=\n\s*(?:ONE_LINER|ACTION|RISK_LEVEL|CONFIDENCE|TARGET_LOW|TARGET_HIGH|STOP_LOSS|POSITION|KEY_POINTS)\s*:|$)/);
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
    action: normalizeAction(actionMatch?.[1]?.trim()),
    oneLiner: oneLinerMatch?.[1]?.trim() || '',
    consensus: consensusMatch?.[1]?.trim() || undefined,
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
  stockCode: string;
  stage1: { systemPrompt: string; userPrompt: string };
  stage2: { systemPrompt: string; userPrompt: string };
  stage3: { systemPrompt: string; userPrompt: string };
  tradeLevels: TradeLevels;
  marketRegime: MarketRegime;
  tushareIssues: string[];
  entryDate: string;
  quote: RealtimeQuote;
  /** 规则引擎信号摘要（裁决 LLM 全失败时规则兜底的依据之一） */
  engineSummary: string;
}

export async function prepareDeepContext(
  selectedCode: string,
  stock: Stock,
  history: AiAnalysisRecord[],
): Promise<DeepContext> {
  const [quote, kLines, tushareData, rpsRes, breadthRes, indexQuotes] = await Promise.all([
    getRealtimeQuoteCached(selectedCode),
    getKLineSinaCached(selectedCode, 240, 120),
    // 缓存版（10min TTL）：重复分析基本面秒出，且去掉原 2s 失败重试占用关键路径；fresh 失败时回退旧缓存
    fetchTushareDataCached(selectedCode),
    getJSONOr<StockRpsResp | null>(`/api/stock/rps?code=${selectedCode}`, null),
    getJSONOr<BreadthResp | null>('/api/market/breadth?days=1', null),
    // 六指数实时行情（行情通道，含盘中）；tushare 指数盘后才有，盘中恒为 T-1
    getMarketIndexQuotes().catch((): MarketIndexQuote[] => []),
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

  // 盘中背离检测：regime 源自最近交易日收盘宽度（T-1），若与今日实时指数明显背离则显式提示。
  // 只提示不改 regimeFactor 数值——仓位公式未经回测验证，数值调整需单独评估。
  let regimeConflictNote = '';
  {
    const pcts = indexQuotes.map(q => q.changePercent).filter(Number.isFinite);
    const quoteDate = indexQuotes[0]?.updateTime?.slice(0, 10) || '';
    if (pcts.length >= 4 && quoteDate === beijingTodayStr()) {
      const avg = pcts.reduce((a, b) => a + b, 0) / pcts.length;
      if (marketRegime === 'strong' && avg <= -1) {
        regimeConflictNote = `[盘中提示] 市场状态基于最近交易日收盘宽度判定为「强势」，但今日六大指数平均 ${avg.toFixed(2)}%，明显背离，仓位评估请按偏弱市场谨慎对待。\n\n`;
      } else if (marketRegime === 'weak' && avg >= 1) {
        regimeConflictNote = `[盘中提示] 市场状态基于最近交易日收盘宽度判定为「弱势」，但今日六大指数平均 +${avg.toFixed(2)}%，明显背离，仓位评估可适当乐观。\n\n`;
      }
    }
  }

  const tushareIssues = [...(tushareData?.errors || []), ...(tushareData?.warnings || [])];
  const tushareBlock = formatTushareForPrompt(tushareData, indexQuotes, quote);

  const updatedKLines = kLines.length >= 5 ? buildUpdatedKLines(quote, kLines) : kLines;
  const chip: ChipDistribution | null = await getChipData(selectedCode).catch(() => null);
  const engineResults = checkAllRules(updatedKLines, quote, ALERT_RULES.filter(r => r.isEnabled), chip);
  const engineSummary = engineResults.length > 0
    ? engineResults.map(r => `${r.ruleId}:${r.message}`).join('; ')
    : '未触发任何破位/死叉/急跌等风险信号，技术面健康';

  const chipNote = chip
    ? `[筹码分布]（数据截至 ${chip.asOfDate ? `${chip.asOfDate.slice(4, 6)}-${chip.asOfDate.slice(6, 8)}` : '最近交易日'} 收盘）\n主峰价位: ${chip.dominantPeak} | 平均成本: ${chip.avgCost} | 获利盘: ${(chip.profitRatio * 100).toFixed(1)}% | 90%集中度: ${chip.concentration90.toFixed(3)}（越小越密集） | 峰位相对位置: ${chip.peakPos.toFixed(3)}（站上主峰为正） | 5日峰位漂移: ${chip.peakDrift.toFixed(3)}（下移为吸筹）\n（筹码形态仅供参考，需结合趋势与量能综合判断）\n\n`
    : '';

  // 紧凑序列化（去掉 2 空格缩进）：quoteJson 同时进分析师与辩论两份 prompt，少 ~40% quote token，无数据损失
  const quoteJson = JSON.stringify(quote);
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
    breadthDate: breadthLatest?.date,
  });
  // 背离提示同时进裁决 prompt（stage3 只带 levelsText，不带 marketStatusNote）
  const levelsText = formatLevelsForPrompt(tradeLevels) + (regimeConflictNote ? `\n${regimeConflictNote.trim()}` : '');

  const reflectionBlock = buildReflectionContext(selectedCode, history, { price: quote.price, changePercent: quote.changePercent });

  const positionNote = stock.positionPercent !== undefined
    ? `注意：该股票占用户总持仓的${stock.positionPercent}%，请在分析中考虑仓位集中度风险。`
    : undefined;
  const positionNoteVerdict = stock.positionPercent !== undefined
    ? `用户当前持仓占比为${stock.positionPercent}%，请在仓位建议中考虑现有持仓，如需减持请明确说明。`
    : undefined;

  const marketStatusNote = `[市场状态] ${await fetchMarketStatusNote()}\n\n${regimeConflictNote}`;
  const rpsDateStr = rpsRes?.calcDate && rpsRes.calcDate.length === 8
    ? `${rpsRes.calcDate.slice(4, 6)}-${rpsRes.calcDate.slice(6, 8)}`
    : '';
  const rpsNote = rpsRes && !rpsRes.error
    ? `[RPS强度] 20日:${rpsRes.rps20?.toFixed(1)} 60日:${rpsRes.rps60?.toFixed(1)} 120日:${rpsRes.rps120?.toFixed(1)} 250日:${rpsRes.rps250?.toFixed(1)}（${(rpsRes.rps250 ?? 0) >= 95 ? '全市场前5%极强' : (rpsRes.rps250 ?? 0) >= 87 ? '强势' : '中等偏弱'}${rpsDateStr ? `，数据截至 ${rpsDateStr} 收盘` : ''}）\n\n`
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

  return { stockCode: selectedCode, stage1, stage2, stage3, tradeLevels, marketRegime, tushareIssues, entryDate, quote, engineSummary };
}

// ── 深度分析执行：浏览器直连（主路径）+ 服务器中转（降级）──────────────
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

/** Jaccard 相似度（bigram 分词）— 辩论轮间卡死检测（与服务器版同） */
function jaccardSimilarity(a: string, b: string): number {
  const bigrams = (s: string) => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const sa = bigrams(a);
  const sb = bigrams(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let intersection = 0;
  for (const gram of sa) if (sb.has(gram)) intersection++;
  return intersection / (sa.size + sb.size - intersection);
}

/** 裁决历史校准注记：从 /api/ai/calibration 拉（数据在服务器 DB，失败返回空串不阻断） */
async function fetchCalibrationNote(stockCode: string): Promise<string> {
  try {
    const res = await getJSON<{ note?: string }>(`/api/ai/calibration?stockCode=${encodeURIComponent(stockCode)}`);
    return res.note || '';
  } catch {
    return '';
  }
}

// 辩论角色展示顺序：R1 三人 → R2 三人。并发执行时按固定顺序拼装，不随完成先后乱序
const DEBATE_R1_KEYS = ['tech', 'risk', 'xinjie'] as const;
const DEBATE_R2_KEYS = ['tech_r2', 'risk_r2', 'xinjie_r2'] as const;

/**
 * 规则引擎兜底裁决：verdict LLM 三档重试全失败时调用，保证"最坏情况也有一份裁决输出"。
 * 纯规则合成（零 LLM 依赖）：方向取规则信号正负，价位/仓位取候选区间，置信度压低并显式标注"兜底"。
 * 输出格式与 LLM verdict 一致（可被 parseVerdictContent 解析 → 落库/展示复用整条链路）。
 */
function buildFallbackVerdict(ctx: DeepContext, degraded: string[]): { text: string; structured: DeepStructured } {
  const { quote, tradeLevels, engineSummary, marketRegime } = ctx;
  const sellSignal = /卖出|清仓|减仓|离场|破位|死叉|见顶|急跌|跌破|下行/.test(engineSummary);
  const buySignal = /买入|金叉|加仓|共振|突破|回踩|放量上攻|支撑/.test(engineSummary);
  const action = sellSignal ? '卖出' : buySignal ? '买入' : '持有';
  const riskLevel = sellSignal ? '中风险' : '低风险';
  const confidence = 45; // 兜底置信度压低调低误导，但保证有输出

  const mid = (lo?: number, hi?: number): number | undefined =>
    (lo != null && hi != null) ? Math.round(((lo + hi) / 2) * 100) / 100 : undefined;
  const tR = tradeLevels.targetRange;
  const sR = tradeLevels.stopLossRange;
  const pR = tradeLevels.positionRange;
  const targetLow = tR?.low, targetHigh = tR?.high;
  const stopLoss = sR ? (mid(sR.low, sR.high) ?? sR.low) : undefined;
  const regimeFactor = marketRegime === 'strong' ? 1.2 : marketRegime === 'weak' ? 0.6 : 1;
  const basePosition = pR ? (mid(pR.low, pR.high) ?? 20) : 20;
  const position = Math.max(10, Math.min(50, Math.round(basePosition * regimeFactor)));

  const oneLiner = `建议${action}。AI 分析生成失败，已退回规则引擎给出兜底建议，请谨慎参考`;
  const reasoning = `AI 分析未能完成（${degraded.join('、')}），已退回规则引擎兜底。\n当前规则信号：${engineSummary || '无特殊信号'}；大盘强弱：${marketRegime === 'strong' ? '强势' : marketRegime === 'weak' ? '弱势' : '中性'}。\n目标/止损/仓位取自结构化候选区间，方向与价格均基于规则而非深度分析，不确定性较高。`;
  const plan = `兜底建议（非 AI 深度分析）。参考价位：目标 ${targetLow ?? '--'}-${targetHigh ?? '--'}，止损 ${stopLoss ?? '--'}，建议仓位 ${position}%。逢关键位确认后再决定是否操作。`;
  const riskNote = '此为规则引擎兜底结果，未经多空辩论与人工校验，风险不确定性较高，务必结合实时行情谨慎决策。';

  const text = [
    `【综合评判】${action === '卖出' ? '空方' : action === '买入' ? '多方' : '中性'}信号占优（规则引擎），本次为兜底裁决。`,
    `ONE_LINER:${oneLiner}`,
    `ACTION:${action}`,
    `RISK_LEVEL:${riskLevel}`,
    `CONFIDENCE:${confidence}`,
    `TARGET_LOW:${targetLow ?? ''}`,
    `TARGET_HIGH:${targetHigh ?? ''}`,
    `STOP_LOSS:${stopLoss ?? ''}`,
    `POSITION:${position}`,
    '---',
    `### 决策理由\n${reasoning}`,
    `### 操作计划\n${plan}`,
    `### 风险提示\n${riskNote}`,
  ].join('\n');

  return { text, structured: parseVerdictContent(text, tradeLevels) };
}

/**
 * 浏览器直连编排 — 镜像服务器 /api/ai/deep-analyze 的逻辑：
 * 波1（分析师 + R1 三人，4 路并发，信息本就独立）→ R2 串行反驳链 → 最终裁决。
 * - 正文逐字直播：analyst/verdict 直接追加；辩论角色按 DEBATE_*_KEYS 顺序拼装
 * - 阶段内重试/卡死检测/超时 fail-fast 与服务器版一致；重试前回滚已直播内容防重复段落
 * - 连接层失败（CORS/TypeError）原样冒泡，由 runDeepAnalysisStream 降级到服务器中转
 * - completedMap 实时写外部传入的 ref，降级/断网时可断点续传
 */
async function runDeepAnalysisDirect(opts: RunDeepOptions, completedMap: Record<string, string>): Promise<RunDeepOutcome> {
  const { ctx, cfg, userView, userViewReason, signal, onProgress } = opts;
  console.info(`[Deep AI Direct] 直连分析开始 model=${cfg.model} baseUrl=${cfg.baseUrl}`);
  // 低并发自适应槽位 key：429 学习按 provider+model+key尾 维度记忆（见 concurrency.ts）
  const llmSlotKey = `${cfg.baseUrl}|${cfg.model}|${(cfg.apiKey || '').slice(-8)}`;

  let analystText = '', analystReasoning = '';
  const debateError = '';
  let verdictText = '', verdictReasoning = '', verdictError: string | undefined = undefined;
  const roleBuf: Record<string, string> = {};
  const roleReasonBuf: Record<string, string> = {};
  let stage: DeepStage = 'idle';
  // 阶段指示单调推进（波1 多路并发会交错，不允许阶段回退造成进度条抖动）
  const stageRank: Record<DeepStage, number> = { idle: 0, analyst: 1, debate: 2, verdict: 3 };
  const advanceStage = (s: DeepStage) => { if (stageRank[s] > stageRank[stage]) stage = s; };

  const composeDebate = (): string => {
    const r1 = DEBATE_R1_KEYS.map(k => roleBuf[k]).filter(Boolean);
    const r2 = DEBATE_R2_KEYS.map(k => roleBuf[k]).filter(Boolean);
    let out = r1.join('\n\n');
    if (r2.length > 0) out += (out ? '\n' : '') + '--- 第二轮 ---\n' + r2.join('\n\n');
    return out;
  };
  const composeDebateReasoning = (): string =>
    [...DEBATE_R1_KEYS, ...DEBATE_R2_KEYS].map(k => roleReasonBuf[k]).filter(Boolean).join('\n\n');

  const emit = (structured?: DeepStructured | null) => {
    onProgress({
      stage,
      result: {
        analyst: analystText,
        analystReasoning: analystReasoning || undefined,
        debate: composeDebate(),
        debateReasoning: composeDebateReasoning() || undefined,
        debateError: debateError || undefined,
        verdict: verdictText,
        verdictReasoning: verdictReasoning || undefined,
        verdictError: verdictError || undefined,
        levels: { current: ctx.tradeLevels.currentPrice, supports: ctx.tradeLevels.supports, resistances: ctx.tradeLevels.resistances },
        structured: structured ?? null,
        analystDone: completedMap['analyst'] != null,
        debateDone: DEBATE_R2_KEYS.every(k => completedMap[k] != null),
        warnings: degraded.length > 0 ? [...degraded] : undefined,
      },
    });
  };

  /** 重试前回滚本轮已直播的内容（正文+思考），防重复段落 */
  const rollbackLive = (stageKey: string, contentLen: number, reasonLen: number) => {
    const trim = (s: string, n: number) => (n > 0 ? s.slice(0, Math.max(0, s.length - n)) : s);
    if (stageKey === 'analyst') { analystText = trim(analystText, contentLen); analystReasoning = trim(analystReasoning, reasonLen); }
    else if (stageKey === 'verdict') { verdictText = trim(verdictText, contentLen); verdictReasoning = trim(verdictReasoning, reasonLen); }
    else {
      if (roleBuf[stageKey] != null) roleBuf[stageKey] = trim(roleBuf[stageKey], contentLen);
      if (roleReasonBuf[stageKey] != null) roleReasonBuf[stageKey] = trim(roleReasonBuf[stageKey], reasonLen);
    }
  };

  /** 单阶段 LLM 调用。重试策略镜像服务器 runStage；连接层错误冒泡供降级判定 */
  const runStage = async (stageKey: string, systemPrompt: string, userPrompt: string, maxTokens = 4096, attempt = 1): Promise<{ text: string; reasoning: string }> => {
    let fullOutput = '', fullReasoning = '';
    let lastDelta = '', repeatCount = 0;
    let stuckWarning = false;
    let finishReason = '';
    const releaseSlot = await acquireLlmSlot(llmSlotKey);
    try {
      await streamChatDirect({
        baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        temperature: 0.3, maxTokens,
        // 240s：思考型模型 + 12288 预算下复杂裁决可思考 8-10k token（约 100-200s），120s 必然撞线（ranker 以 300s 配 12288）
        signal, timeoutMs: 240000,
        onFinish: (r) => { finishReason = r; },
        onDelta: (d) => {
          if (d.reasoning) {
            fullReasoning += d.reasoning;
            if (stageKey === 'analyst') { analystReasoning += d.reasoning; advanceStage('analyst'); emit(); }
            else if (stageKey === 'verdict') { verdictReasoning += d.reasoning; advanceStage('verdict'); emit(); }
            else { roleReasonBuf[stageKey] = (roleReasonBuf[stageKey] || '') + d.reasoning; advanceStage('debate'); emit(); }
          }
          if (d.content) {
            if (d.content === lastDelta) repeatCount++;
            else { repeatCount = 0; lastDelta = d.content; }
            if (repeatCount >= 3 && !stuckWarning) {
              stuckWarning = true;
              console.warn(`[Deep AI Direct] ${stageKey} 检测到卡死（连续重复输出）`);
            }
            fullOutput += d.content;
            // 正文逐字直播（直连主路径的体验核心；verdict 顺带渐进解析结构化字段，卡片逐字段亮起）
            if (stageKey === 'analyst') { analystText += d.content; advanceStage('analyst'); emit(); }
            else if (stageKey === 'verdict') { verdictText += d.content; advanceStage('verdict'); emit(parseVerdictContent(verdictText, ctx.tradeLevels)); }
            else { roleBuf[stageKey] = (roleBuf[stageKey] || '') + d.content; advanceStage('debate'); emit(); }
          }
        },
      });
    } catch (e: any) {
      if (e.name === 'AbortError') throw e; // 用户取消，原样冒泡
      // 429 限流：学到该 key 低并发（后续调用串行排队），warnings 记一条"变慢但完整"的提示
      if (e instanceof LlmHttpError && e.status === 429) {
        if (noteLlmRateLimited(llmSlotKey) && !degraded.includes('rate_limited')) degraded.push('rate_limited');
      }
      const isTimeout = /超时|timeout/i.test(e.message || '');
      if (isTimeout) throw new Error(`[${stageKey}] 阶段超时（240s），模型未在限定时间内响应`);
      const isRetryableNetwork = e.name === 'TypeError' || /fetch|network/i.test(e.message || '');
      // max_tokens 400 兜底（镜像 ranker）：中转/厂商把 max_tokens 卡得更小时报 400，降档 4096 重试避免整档失败
      const maxTokensTooBig = e instanceof LlmHttpError && e.status === 400
        && /max[_ -]?tokens?|max completion/i.test(e.message || '') && maxTokens > 4096;
      const retryable = (attempt < 2 && isRetryableNetwork)
        || (e instanceof LlmHttpError && attempt < 2 && (e.status === 429 || e.status >= 500))
        || maxTokensTooBig;
      if (retryable) {
        rollbackLive(stageKey, fullOutput.length, fullReasoning.length);
        emit();
        const backoff = 2000 * attempt;
        console.warn(`[Deep AI Direct] ${stageKey} 可重试错误，${backoff}ms 后重试 ${attempt}/2${maxTokensTooBig ? '（max_tokens 降档 4096）' : ''}`);
        await new Promise(r => setTimeout(r, backoff));
        return runStage(stageKey, systemPrompt, userPrompt, maxTokensTooBig ? 4096 : maxTokens, attempt + 1);
      }
      throw e.message?.startsWith(`[${stageKey}]`)
        ? e
        : new Error(`[${stageKey}] ${e.message || '未知错误'}`);
    } finally {
      releaseSlot();
    }

    if (!fullOutput.trim()) {
      console.warn(`[Deep AI Direct] ${stageKey} 输出为空（流式响应无 content 增量），重试 ${attempt}/2`);
      if (attempt < 2) {
        rollbackLive(stageKey, fullOutput.length, fullReasoning.length);
        emit();
        return runStage(stageKey, systemPrompt, userPrompt, maxTokens, attempt + 1);
      }
      throw new Error(`[${stageKey}] 输出为空`);
    }
    // finish_reason='length'：思考型模型思考烧光预算、正文被截断。同样输入重试会同样截断，
    // 直接抛给外层降级链（裁决三档递减/规则兜底），而不是把残次输出静默当成功
    if (finishReason === 'length') {
      throw new Error(`[${stageKey}] 输出被截断（达到 token 上限 ${maxTokens}）`);
    }
    return { text: fullOutput, reasoning: fullReasoning };
  };

  /** 断点续传：completedMap 命中回放，否则 runStage 直播；完成后权威覆盖 + 写断点 */
  const runOrReplay = async (stageKey: string, sys: string, usr: string, maxTokens: number, isDebate = false): Promise<string> => {
    const cached = completedMap[stageKey];
    if (cached != null) {
      if (isDebate) { roleBuf[stageKey] = cached; advanceStage('debate'); emit(); }
      else if (stageKey === 'analyst') { analystText = cached; advanceStage('analyst'); emit(); }
      else if (stageKey === 'verdict') { verdictText = cached; advanceStage('verdict'); emit(parseVerdictContent(verdictText, ctx.tradeLevels)); }
      return cached;
    }
    const { text, reasoning } = await runStage(stageKey, sys, usr, maxTokens);
    if (isDebate) {
      roleBuf[stageKey] = text;
      if (reasoning) roleReasonBuf[stageKey] = reasoning;
      advanceStage('debate');
      emit();
    } else if (stageKey === 'analyst') {
      analystText = text;
      advanceStage('analyst');
      emit();
    } else if (stageKey === 'verdict') {
      verdictText = text;
      if (reasoning) verdictReasoning = reasoning;
      advanceStage('verdict');
      emit(parseVerdictContent(verdictText, ctx.tradeLevels));
    }
    completedMap[stageKey] = text;
    saveDeepResume(ctx.stockCode, completedMap);
    return text;
  };

  // ===== 波1 前置：辩论基础数据（不含分析师报告，角色不需要读完整报告）=====
  const userViewNote = userView ? `\n\n[用户观点] 用户当前${userView}。理由：${userViewReason || '未说明'}。\n各角色在论证时可参考用户观点，但不要迎合——用数据验证或反驳用户的看法。` : '';
  const debateData = [
    ctx.stage2.userPrompt.split('以下是一份深度分析师报告')[0]?.trim() || '',
    userViewNote,
  ].filter(Boolean).join('\n\n');

  // 降级清单：记录哪些阶段失败/被跳过 → 拼进裁决输入降级 + 展示给用户
  const degraded: string[] = [];
  /** 宽容执行：失败的角色记入 degraded 返回空串，不再"任一失败即终止整次分析"——裁决是核心产出，上游被截断也要尽量出裁决 */
  const safeRun = async (stageKey: string, sys: string, usr: string, maxTokens: number, isDebate = false): Promise<string> => {
    try {
      return await runOrReplay(stageKey, sys, usr, maxTokens, isDebate);
    } catch (e: any) {
      if (e.name === 'AbortError') throw e;
      degraded.push(stageKey);
      console.warn(`[Deep AI Direct] ${stageKey} 失败，跳过继续：${e.message}`);
      return '';
    }
  };

  // ===== 波1：分析师 + R1 三人 4 路并发（宽容：成功几个算几个）=====
  // max_tokens 分级：分析师/裁决 12288（重思考，同 ranker 实测值），辩论 4096（思考量小，2倍余量防截断）
  // 分析师在后台跑，R2 反驳链不依赖分析师报告 → R1 完成后立即启动 R2，让 R2 串行耗时与分析师生成重叠（提速，质量不变）
  const analystPromise = safeRun('analyst', ctx.stage1.systemPrompt, ctx.stage1.userPrompt, 12288);
  analystPromise.catch(() => {}); // 后台 promise 仅在用户取消时 reject，统一由后续 await 处理
  const r1Settled = await Promise.allSettled([
    safeRun('tech', buildTechR1SystemPrompt(), debateData, 4096, true),
    safeRun('risk', buildRiskR1SystemPrompt(), debateData, 4096, true),
    safeRun('xinjie', buildXinJieR1DebatePrompt(), debateData, 4096, true),
  ]);
  const t1 = (r1Settled[0] as PromiseFulfilledResult<string>).value;
  const r1 = (r1Settled[1] as PromiseFulfilledResult<string>).value;
  const x1 = (r1Settled[2] as PromiseFulfilledResult<string>).value;

  // ===== R2：串行反驳链（宽容；前一步失败用空串占位，不阻断后续）=====
  const techR2Ctx = `前面两人的第一轮发言：\n${r1}\n${x1}\n\n请回应以上两人的观点。`;
  const techR2 = await safeRun('tech_r2', buildTechR2RebuttalPrompt(), techR2Ctx, 4096, true);

  const riskR2Ctx = `第一轮发言回顾：\n${t1}\n${x1}\n\n技术分析师的回应：\n${techR2}\n\n请回应以上内容。`;
  const riskR2 = await safeRun('risk_r2', buildRiskR2RebuttalPrompt(), riskR2Ctx, 4096, true);

  const xinjieR2Ctx = `第一轮：\n${t1}\n${r1}\n\n第二轮回应：\n技术分析师："${techR2.slice(0, 200)}"\n风控专家："${riskR2.slice(0, 200)}"\n\n请给出你的最终判断。`;
  const xinjieR2 = await safeRun('xinjie_r2', buildXinJieR2RebuttalPrompt(), xinjieR2Ctx, 4096, true);

  // 裁决需要分析师报告：R2 链完成后收口等分析师结束（若分析师更快，这里已 resolve）
  const stage1Output = await analystPromise;

  const r1Text = [t1, r1, x1].filter(Boolean).join('\n\n');
  const r2Text = [techR2, riskR2, xinjieR2].filter(Boolean).join('\n\n');
  const stage2Output = [r1Text, r2Text && `--- 第二轮 ---\n${r2Text}`].filter(Boolean).join('\n\n');

  // 卡死检测（仅当两轮都有内容，空串会误判相似度 1）
  if ((t1 || r1 || x1) && (techR2 || riskR2 || xinjieR2)) {
    const similarity = jaccardSimilarity(t1 + r1 + x1, techR2 + riskR2 + xinjieR2);
    if (similarity >= 0.7) {
      console.warn(`[Deep AI Direct] 辩论轮间相似度过高 (${(similarity * 100).toFixed(0)}%)`);
    }
  }

  // ===== 阶段三：最终裁决（核心产出，三档降级 + 规则兜底，确保"最坏也有裁决"）=====
  const s3System = ctx.stage3.systemPrompt || buildVerdictSystemPrompt();
  const userViewVerdict = userView ? `\n\n[用户观点] 用户当前${userView}，理由：${userViewReason || '未说明'}。请在决策理由中评价用户观点是否成立（用数据说话，不要迎合用户）。` : '';
  // P2：历史校准注入（真实回测胜率，拼在 ## 分析师报告 前；样本不足/失败返回空串）
  const calibrationNote = await fetchCalibrationNote(ctx.stockCode);
  const s3Base = [
    ctx.stage3.userPrompt.split('## 分析师报告')[0]?.trim() || '',
    // 辩论不可用时提示模型无需综合评判（综合评判本是对比辩论三人的）
    (!stage2Output && !stage1Output ? '[提示] 本次分析师报告与辩论均未能生成，请直接基于行情与结构化候选价位给出决策，无需综合评判。' : ''),
  ].filter(Boolean).join('\n\n');

  const buildS3User = (withAnalyst: boolean, withDebate: boolean, withCalibration: boolean): string => {
    const parts: string[] = [s3Base];
    if (withCalibration && calibrationNote) parts.push(calibrationNote);
    if (withAnalyst && stage1Output) parts.push(`## 分析师报告\n${stage1Output}`);
    if (withDebate && stage2Output) parts.push(`## 多空辩论\n${stage2Output}`);
    parts.push(userViewVerdict);
    parts.push('请基于以上信息，做出最终投资决策。**注意：目标价和止损价必须参考实时行情中的当前价格。**');
    return parts.filter(Boolean).join('\n\n');
  };

  // 降级档位：完整 → 去辩论+去校准（输入大幅减小，模型更容易成功）→ 极简（仅基础数据）
  const VERDICT_ATTEMPTS: [boolean, boolean, boolean][] = [
    [true, true, true],
    [true, false, false],
    [false, false, false],
  ];
  let verdictOk = false;
  let lastVerdictError = '';
  for (let attempt = 0; attempt < VERDICT_ATTEMPTS.length; attempt++) {
    const [withAnalyst, withDebate, withCalibration] = VERDICT_ATTEMPTS[attempt];
    // 该档没有比上一档更少的内容时跳过（避免无意义重复）
    if (attempt > 0) {
      const hasFull = stage1Output && stage2Output;
      const sameInput = (attempt === 1 && (!stage2Output || !hasFull)) || (attempt === 2 && !stage1Output);
      if (sameInput) continue;
    }
    try {
      const usr = buildS3User(withAnalyst, withDebate, withCalibration);
      await runOrReplay('verdict', s3System, usr, 12288);
      verdictOk = true;
      break;
    } catch (e: any) {
      if (e.name === 'AbortError') throw e;
      lastVerdictError = e.message || '未知原因';
      degraded.push(`verdict_attempt${attempt + 1}`);
      console.warn(`[Deep AI Direct] 裁决第${attempt + 1}档失败，降级重试：${e.message}`);
      // 清空已直播残片，防降级结果前缀重复
      verdictText = '';
      verdictReasoning = '';
      verdictError = undefined;
      emit(parseVerdictContent('', ctx.tradeLevels));
    }
  }

  if (!verdictOk) {
    // 规则兜底：零 LLM 依赖，保证"最坏情况也有一份裁决输出"
    degraded.push('fallback_rule');
    const fallback = buildFallbackVerdict(ctx, degraded);
    verdictText = fallback.text;
    verdictError = `AI 裁决生成失败（${lastVerdictError}），已退回规则引擎兜底`;
    emit(fallback.structured);
    console.warn(`[Deep AI Direct] 裁决三档均失败，已生成规则兜底裁决（${degraded.join(',')}）`);
  }

  const finalStructured = parseVerdictContent(verdictText, ctx.tradeLevels);
  return {
    result: {
      analyst: analystText,
      analystReasoning: analystReasoning || undefined,
      debate: composeDebate(),
      debateReasoning: composeDebateReasoning() || undefined,
      debateError: debateError || undefined,
      verdict: verdictText,
      verdictReasoning: verdictReasoning || undefined,
      verdictError: verdictError || undefined,
      levels: { current: ctx.tradeLevels.currentPrice, supports: ctx.tradeLevels.supports, resistances: ctx.tradeLevels.resistances },
      structured: finalStructured,
      analystDone: true,
      debateDone: true,
      warnings: degraded.length > 0 ? [...degraded] : undefined,
    },
    completedMap,
  };
}

/**
 * 深度分析入口：优先浏览器直连（省服务器出站流量 + 少一跳香港）。
 * 直连不可达（CORS / TypeError / 超时 / 空输出）→ 降级服务器中转，已完成阶段断点续传重跑。
 * 空输出也算降级：浏览器环境可能吞流（代理/中间件），服务器侧通常正常。
 */
// ── 直连熔断：连续失败降级并冷却，防止重试风暴烧 token / 触发限流 ──────
const DIRECT_CIRCUIT_KEY = 'ai-direct-circuit';
const CIRCUIT_MAX_FAILURES = 3;
const CIRCUIT_TTL_MS = 24 * 3600 * 1000;

function readCircuit(): { count: number; at: number } {
  try {
    const raw = localStorage.getItem(DIRECT_CIRCUIT_KEY);
    if (!raw) return { count: 0, at: 0 };
    const parsed = JSON.parse(raw);
    return { count: Number(parsed.count) || 0, at: Number(parsed.at) || 0 };
  } catch {
    return { count: 0, at: 0 };
  }
}

function isDirectCircuited(): boolean {
  const c = readCircuit();
  return c.count >= CIRCUIT_MAX_FAILURES && Date.now() - c.at < CIRCUIT_TTL_MS;
}

function recordDirectFailure(): void {
  try {
    const c = readCircuit();
    localStorage.setItem(DIRECT_CIRCUIT_KEY, JSON.stringify({ count: c.count + 1, at: Date.now() }));
  } catch { /* 隐私模式等忽略 */ }
}

function resetDirectCircuit(): void {
  try {
    localStorage.setItem(DIRECT_CIRCUIT_KEY, JSON.stringify({ count: 0, at: 0 }));
  } catch { /* 忽略 */ }
}

// ── 断点持久化：每完成一个阶段写 localStorage，中断/刷新/锁屏后可恢复续跑 ──
const RESUME_KEY = 'deep-analysis-resume';
const RESUME_TTL_MS = 7 * 24 * 3600 * 1000; // 断点 7 天后过期

export interface DeepResume {
  stockCode: string;
  completed: Record<string, string>;
  savedAt: number;
}

export function loadDeepResume(): DeepResume | null {
  try {
    const raw = localStorage.getItem(RESUME_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DeepResume;
    if (!parsed.completed || typeof parsed.stockCode !== 'string' || Object.keys(parsed.completed).length === 0) return null;
    if (Date.now() - (parsed.savedAt || 0) > RESUME_TTL_MS) {
      localStorage.removeItem(RESUME_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearDeepResume(): void {
  try { localStorage.removeItem(RESUME_KEY); } catch { /* 忽略 */ }
}

/** 保存断点（同标的合并：保留旧键，新阶段覆盖） */
function saveDeepResume(stockCode: string, completed: Record<string, string>): void {
  try {
    const prev = loadDeepResume();
    const merged = {
      ...(prev && prev.stockCode === stockCode ? prev.completed : {}),
      ...completed,
    };
    localStorage.setItem(RESUME_KEY, JSON.stringify({ stockCode, completed: merged, savedAt: Date.now() }));
  } catch { /* localStorage 满/隐私模式忽略 */ }
}

/**
 * 深度分析入口：优先浏览器直连（省服务器出站流量 + 少一跳香港）。
 * - 直连不可达（CORS / TypeError / 超时 / 空输出）→ 计数并降级服务器中转，已完成阶段断点续传
 * - 连续失败熔断：24h 内不再尝试直连，直接走服务器（手机移动网络等环境直连不稳时自动让位）
 * - 直连成功自动清零熔断计数
 * - 断点持久化：每完成一个阶段写 localStorage，任何失败/中断后刷新页面仍可"继续生成"续跑
 */
export async function runDeepAnalysisStream(opts: RunDeepOptions): Promise<RunDeepOutcome> {
  if (isDirectCircuited()) {
    console.warn('[Deep AI Direct] 熔断冷却中（连续失败过多），直接走服务器中转');
    return runDeepAnalysisViaServer(opts, { ...(opts.resumeCompleted || {}) });
  }
  const completedRef: Record<string, string> = { ...(opts.resumeCompleted || {}) };
  try {
    const outcome = await runDeepAnalysisDirect(opts, completedRef);
    resetDirectCircuit();
    clearDeepResume(); // 完整分析成功，断点作废
    return outcome;
  } catch (e: any) {
    if (e.name === 'AbortError') throw e; // 用户主动取消，不存断点
    if (isDirectConnectionError(e) || /输出为空|阶段超时/.test(e.message || '')) {
      recordDirectFailure();
      console.warn('[Deep AI Direct] 直连异常，降级服务器中转:', e.message);
      try {
        const outcome = await runDeepAnalysisViaServer(opts, completedRef);
        clearDeepResume(); // 完整分析成功，断点作废
        return outcome;
      } catch (e2: any) {
        if (e2.name !== 'AbortError') saveDeepResume(opts.ctx.stockCode, completedRef);
        throw e2;
      }
    }
    saveDeepResume(opts.ctx.stockCode, completedRef);
    throw e;
  }
}

/** 降级路径：服务器中转 SSE（原实现保留，作兜底）。completedMap 与直连路径共享同一对象，断点进度不丢 */
async function runDeepAnalysisViaServer(opts: RunDeepOptions, completedMap: Record<string, string>): Promise<RunDeepOutcome> {
  const { ctx, cfg, signal, onProgress } = opts;
  const { userView, userViewReason } = opts;

  const res = await fetch('/api/ai/deep-analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      stockCode: ctx.stockCode,
      stage1: ctx.stage1, stage2: ctx.stage2, stage3: ctx.stage3,
      baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model,
      // 直连已完成的阶段一并上送，服务器回放跳过（而不是重跑）
      completed: completedMap,
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
  let debateError = '';
  let verdictText = '', verdictReasoning = '', verdictError: string | undefined = undefined;
  const roleBuf: Record<string, string> = {};
  const roleReasonBuf: Record<string, string> = {};
  const warnings: string[] = [];
  let stage: DeepStage = 'idle';
  const stageRank: Record<DeepStage, number> = { idle: 0, analyst: 1, debate: 2, verdict: 3 };
  const advanceStage = (s: DeepStage) => { if (stageRank[s] > stageRank[stage]) stage = s; };

  const composeDebate = (): string => {
    const r1 = DEBATE_R1_KEYS.map(k => roleBuf[k]).filter(Boolean);
    const r2 = DEBATE_R2_KEYS.map(k => roleBuf[k]).filter(Boolean);
    let out = r1.join('\n\n');
    if (r2.length > 0) out += (out ? '\n' : '') + '--- 第二轮 ---\n' + r2.join('\n\n');
    return out;
  };
  const composeDebateReasoning = (): string =>
    [...DEBATE_R1_KEYS, ...DEBATE_R2_KEYS].map(k => roleReasonBuf[k]).filter(Boolean).join('\n\n');

  const emit = (structured?: DeepStructured | null) => {
    onProgress({
      stage,
      result: {
        analyst: analystText,
        analystReasoning: analystReasoning || undefined,
        debate: composeDebate(),
        debateReasoning: composeDebateReasoning() || undefined,
        debateError: debateError || undefined,
        verdict: verdictText,
        verdictReasoning: verdictReasoning || undefined,
        verdictError: verdictError || undefined,
        levels: { current: ctx.tradeLevels.currentPrice, supports: ctx.tradeLevels.supports, resistances: ctx.tradeLevels.resistances },
        structured: structured ?? null,
        analystDone: completedMap['analyst'] != null,
        debateDone: DEBATE_R2_KEYS.every(k => completedMap[k] != null),
        warnings: warnings.length > 0 ? [...warnings] : undefined,
      },
    });
  };

  // 服务器裁决彻底失败（route 已尽力三档降级）→ 客户端用 ctx 的 levels + 规则信号做兜底，保证"最坏也有裁决"
  try {
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

          // 辩论角色实时增量（stage=tech/risk/...）：追加到角色缓冲，拼装顺序固定
          if ((DEBATE_R1_KEYS as readonly string[]).includes(msg.stage) || (DEBATE_R2_KEYS as readonly string[]).includes(msg.stage)) {
            if (msg.text !== undefined) { roleBuf[msg.stage] = (roleBuf[msg.stage] || '') + msg.text; advanceStage('debate'); emit(); }
            if (msg.reasoning) { roleReasonBuf[msg.stage] = (roleReasonBuf[msg.stage] || '') + msg.reasoning; emit(); }
          }
          if (msg.stage === 'analyst') {
            // full 为权威全量（回放/完成校正），否则是流式增量
            if (msg.full !== undefined) { analystText = msg.full; advanceStage('analyst'); emit(); }
            else if (msg.text !== undefined) { analystText += msg.text; advanceStage('analyst'); emit(); }
            if (msg.reasoning) { analystReasoning += msg.reasoning; emit(); }
            if (msg.done) { completedMap.analyst = analystText; saveDeepResume(ctx.stockCode, completedMap); }
          }
          if (msg.stage === 'debate') {
            // 角色完成消息：权威覆盖（防重试/丢包造成的增量重复或缺失）
            if (msg.role && msg.text !== undefined) {
              const text = msg.text.replace(/\n+$/, '');
              roleBuf[msg.role] = text;
              completedMap[msg.role] = text;
              saveDeepResume(ctx.stockCode, completedMap);
              advanceStage('debate');
              emit();
            }
            if (msg.reasoning && msg.role) { roleReasonBuf[msg.role] = msg.reasoning; emit(); }
            if (msg.error) { debateError = msg.error; emit(); }
          }
          if (msg.stage === 'verdict') {
            // reset：路由裁决降级重试前清掉已流式残片，防前缀重复
            if (msg.reset) {
              verdictText = '';
              verdictReasoning = '';
              verdictError = undefined;
              emit(parseVerdictContent('', ctx.tradeLevels));
            }
            // warnings：路由把降级清单透传上来（上游角色被跳过的提示）
            if (Array.isArray(msg.warnings)) {
              warnings.push(...msg.warnings.map(String));
              emit();
            }
            if (msg.full !== undefined) { verdictText = msg.full; advanceStage('verdict'); emit(parseVerdictContent(verdictText, ctx.tradeLevels)); }
            else if (msg.text !== undefined) {
              verdictText += msg.text;
              advanceStage('verdict');
              emit(parseVerdictContent(verdictText, ctx.tradeLevels));
            }
            if (msg.reasoning) { verdictReasoning += msg.reasoning; emit(); }
            if (msg.done) { completedMap.verdict = verdictText; saveDeepResume(ctx.stockCode, completedMap); }
            if (msg.error) { verdictError = msg.error; emit(); }
          }
        } catch (e: any) {
          if (e.message && !e.message.includes('JSON')) {
            // 服务器路径中途失败（断点已由各 done 消息实时落盘）→ 交给外层 catch 做规则兜底
            throw e;
          }
        }
      }
    }
  } catch (e: any) {
    if (e.name === 'AbortError') throw e;
    // 裁决彻底失败 → 规则兜底（levels + 规则信号），保证"最坏情况也有裁决输出"
    warnings.push('server_verdict_failed', 'fallback_rule');
    console.warn('[Deep AI Direct] 服务器中转裁决失败，退回规则兜底:', e.message);
    const fb = buildFallbackVerdict(ctx, warnings);
    verdictText = fb.text;
    verdictError = `AI 裁决生成失败（${e.message || '未知原因'}），已退回规则引擎兜底`;
    emit(fb.structured);
  }

  const finalStructured = parseVerdictContent(verdictText, ctx.tradeLevels);
  return {
    result: {
      analyst: analystText,
      analystReasoning: analystReasoning || undefined,
      debate: composeDebate(),
      debateReasoning: composeDebateReasoning() || undefined,
      debateError: debateError || undefined,
      verdict: verdictText,
      verdictReasoning: verdictReasoning || undefined,
      verdictError: verdictError || undefined,
      levels: { current: ctx.tradeLevels.currentPrice, supports: ctx.tradeLevels.supports, resistances: ctx.tradeLevels.resistances },
      structured: finalStructured,
      analystDone: true,
      debateDone: true,
      warnings: warnings.length > 0 ? [...warnings] : undefined,
    },
    completedMap,
  };
}

// ── 历史摘要组装 + 全局回测落库 ─────────────────────────────────────
export function buildDeepSummary(result: DeepResult): string {
  // 综合评判已并入裁决输出（structured.consensus）；旧格式历史记录兜底从辩论文本解析
  let debateConclusion = result.structured?.consensus || '';
  if (!debateConclusion) {
    const debateMatch = result.debate.match(/【综合评判】([\s\S]*?)(?=\n【|\n###|\n$|$)/);
    if (debateMatch) debateConclusion = debateMatch[1].trim();
  }

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
  marketRegime?: MarketRegime;
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
      marketRegime: params.marketRegime ?? null,
    });
  } catch {
    // 回测落库失败不阻断分析
  }
}
