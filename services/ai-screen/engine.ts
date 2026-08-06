/**
 * AI 筛选 — 编排引擎
 *
 * 流程：L1 候选池(SQL) → enrich(算技术特征 + TS 侧技术硬筛)
 *      → 因子打分 → LLM 重排(可选) → 风险层 → 组合分散 → 截取 maxOutput
 * 设计参考 alphasift pipeline.screen()，分层独立可降级。
 */

import { randomUUID } from 'crypto';
import type { AiPick, AiScreenRun, CandidateRaw, LlmConfig, StrategyPreset } from './types';
import { fetchCandidates } from './candidates';
import { macdStatus, rsiStatus, volatility20d, maxDrawdown20d, atr20pct, volumeRatio, signalScore, maBullish, pullbackToMa20Pct, breakout20dPct, chipFeatures } from './indicators';
import { computeScreenScores } from './scorer';
import { rankCandidates } from './ranker';
import { applyRiskOverlay, applyPortfolioOverlay } from './risk';

/** CandidateRaw → AiPick，计算技术特征；返回 null 表示被 TS 侧技术硬筛剔除 */
function enrich(c: CandidateRaw, preset: StrategyPreset): AiPick | null {
  const closes = c.closes;
  const highs = c.highs;
  const lows = c.lows;
  const vols = c.vols;
  if (closes.length < 20 || c.latestClose == null) return null;

  const macd = macdStatus(closes);
  const rsiS = rsiStatus(closes);
  const vol20 = volatility20d(closes);
  const dd20 = maxDrawdown20d(closes);
  const atr20 = highs.length === closes.length ? atr20pct(closes, highs, lows) : null;
  const vr = volumeRatio(vols);
  const sig = signalScore(closes, vols);
  const mab = maBullish(closes);
  const pb = pullbackToMa20Pct(closes);
  const bo = highs.length === closes.length ? breakout20dPct(closes, highs) : null;
  const chip = chipFeatures(closes, highs, lows, vols, c.turnoverRates, c.latestClose);

  // TS 侧技术硬筛
  const hf = preset.hardFilters;
  if (hf.volatility20dPctMax != null && vol20 != null && vol20 > hf.volatility20dPctMax) return null;
  if (hf.maxDrawdown20dPctMin != null && dd20 != null && dd20 < hf.maxDrawdown20dPctMin) return null;
  if (hf.requireMaBullish && mab !== true) return null;

  return {
    tsCode: c.tsCode,
    name: c.name,
    industry: c.industry,
    rps: c.rps,
    latestClose: c.latestClose,
    latestChange: c.latestChange,
    latestAmount: c.latestAmount,
    ret60d: c.ret60d,
    macdStatus: macd,
    rsiStatus: rsiS,
    volatility20d: vol20,
    maxDrawdown20d: dd20,
    atr20: atr20,
    volumeRatio: vr,
    signalScore: sig,
    maBullish: mab,
    pullbackToMa20Pct: pb,
    breakout20dPct: bo,
    chipConcentration: chip.chipConcentration,
    chipProfitRatio: chip.chipProfitRatio,
    chipPeakPos: chip.chipPeakPos,
    chipPeakDrift: chip.chipPeakDrift,
    roe: c.roe,
    grossprofitMargin: c.grossprofitMargin,
    orYoy: c.orYoy,
    industryChangePct: c.industryChangePct,
    factorScores: {},
    screenScore: 0,
    llmScore: null,
    llmConfidence: null,
    llmSector: '',
    llmTheme: '',
    llmThesis: '',
    rankingReason: '',
    riskSummary: '',
    llmCatalysts: [],
    llmRisks: [],
    llmTags: [],
    llmStyleFit: '',
    llmWatchItems: [],
    llmInvalidators: [],
    finalScore: 0,
    riskScore: null,
    riskLevel: 'low',
    riskPenalty: 0,
    riskFlags: [],
    portfolioPenalty: 0,
    selected: false,
    rank: 0,
    entryPrice: c.latestClose,
    entryDate: '',
  };
}

export interface ScreenOutcome {
  run: AiScreenRun;
  candidates: AiPick[]; // 全候选(含 selected 标记 + screenScore),供落库 + IC/A/B
  picks: AiPick[]; // 选中 top-N(selected=true, rank 1..N),供展示
}

/**
 * 跑一次 AI 筛选。
 * @param preset 策略预设
 * @param llmCfg LLM 配置(preset.llmRerank=false 时可不传)
 */
export async function runScreen(preset: StrategyPreset, llmCfg?: LlmConfig): Promise<ScreenOutcome> {
  const degradation: string[] = [];
  const { barDate, candidates } = await fetchCandidates(preset);

  // enrich + TS 侧技术硬筛
  let picks: AiPick[] = [];
  for (const c of candidates) {
    const p = enrich(c, preset);
    if (p) {
      p.entryDate = barDate;
      picks.push(p);
    }
  }
  const filteredCount = picks.length;
  if (candidates.length > 0 && picks.length === 0) {
    degradation.push('all_filtered_by_technical_hard_filter');
  }

  // 因子打分(全候选)
  computeScreenScores(picks, preset);

  // LLM 重排(可选,仅对 topK 打分)
  let llmRanked = false;
  let llmModel: string | null = null;
  let marketView = '';
  let selectionLogic = '';
  let portfolioRisk = '';
  let coverage: number | null = null;

  if (preset.llmRerank && llmCfg && picks.length > 0) {
    llmModel = llmCfg.model;
    const r = await rankCandidates(picks, preset, llmCfg);
    picks = r.picks;
    // 增量续打语义：topK 全部有 LLM 分才算"重排完成"（可共享缓存）；部分有分保留但不封版，后续补救续打
    llmRanked = r.completed;
    marketView = r.marketView;
    selectionLogic = r.selectionLogic;
    portfolioRisk = r.portfolioRisk;
    coverage = r.coverage;
    degradation.push(...r.degradation);
  } else {
    // 不走 LLM:final = screen_score,按规则分排
    picks.sort((a, b) => b.screenScore - a.screenScore);
    for (const k of picks) k.finalScore = k.screenScore;
    if (preset.llmRerank && !llmCfg) degradation.push('llm_config_missing');
  }

  // 风险层 + 组合层
  picks = applyRiskOverlay(picks, preset);
  picks = applyPortfolioOverlay(picks, preset);

  // 选中 top-N,标记 selected/rank(覆盖 overlay 临时设的 rank)
  const selected = picks.slice(0, preset.maxOutput);
  for (const k of picks) {
    k.selected = false;
    k.rank = 0;
  }
  selected.forEach((k, i) => {
    k.selected = true;
    k.rank = i + 1;
  });

  const run: AiScreenRun = {
    id: randomUUID(),
    strategyId: preset.id,
    strategyName: preset.name,
    createdAt: new Date().toISOString(),
    barDate,
    rpsPeriod: preset.hardFilters.rpsPeriod ?? 60,
    candidateCount: filteredCount,
    pickCount: selected.length,
    llmReranked: llmRanked,
    llmModel,
    llmMarketView: marketView,
    llmSelectionLogic: selectionLogic,
    llmPortfolioRisk: portfolioRisk,
    llmCoverage: coverage,
    degradation,
    riskEnabled: true,
    portfolioEnabled: !!preset.portfolioProfile,
  };

  return { run, candidates: picks, picks: selected };
}

/** DB Pick 行 → AiPick（补救重排时用，所有字段都已持久化） */
export function dbPickToAiPick(r: any): AiPick {
  return {
    tsCode: r.tsCode,
    name: r.name,
    industry: r.industry,
    rps: r.rps,
    latestClose: r.latestClose,
    latestChange: r.latestChange,
    latestAmount: r.latestAmount,
    ret60d: r.ret60d,
    macdStatus: r.macdStatus ?? 'neutral',
    rsiStatus: r.rsiStatus ?? 'neutral',
    volatility20d: r.volatility20d,
    maxDrawdown20d: r.maxDrawdown20d,
    atr20: r.atr20,
    volumeRatio: r.volumeRatio,
    signalScore: r.signalScore,
    maBullish: r.maBullish ?? null,
    pullbackToMa20Pct: r.pullbackToMa20Pct ?? null,
    breakout20dPct: r.breakout20dPct ?? null,
    chipConcentration: r.chipConcentration ?? null,
    chipProfitRatio: r.chipProfitRatio ?? null,
    chipPeakPos: r.chipPeakPos ?? null,
    chipPeakDrift: r.chipPeakDrift ?? null,
    roe: r.roe,
    grossprofitMargin: r.grossprofitMargin,
    orYoy: r.orYoy,
    industryChangePct: r.industryChangePct,
    factorScores: (r.factorScores as Record<string, number>) ?? {},
    screenScore: r.screenScore,
    llmScore: r.llmScore,
    llmConfidence: r.llmConfidence,
    llmSector: r.llmSector ?? '',
    llmTheme: r.llmTheme ?? '',
    llmThesis: r.llmThesis ?? '',
    rankingReason: r.rankingReason ?? '',
    riskSummary: r.riskSummary ?? '',
    llmCatalysts: r.llmCatalysts ?? [],
    llmRisks: r.llmRisks ?? [],
    llmTags: r.llmTags ?? [],
    llmStyleFit: r.llmStyleFit ?? '',
    llmWatchItems: r.llmWatchItems ?? [],
    llmInvalidators: r.llmInvalidators ?? [],
    finalScore: r.finalScore,
    riskScore: r.riskScore,
    riskLevel: r.riskLevel ?? 'low',
    riskPenalty: r.riskPenalty ?? 0,
    riskFlags: r.riskFlags ?? [],
    portfolioPenalty: r.portfolioPenalty ?? 0,
    selected: r.selected ?? false,
    rank: r.rank ?? 0,
    entryPrice: r.entryPrice,
    entryDate: r.entryDate ?? '',
  };
}

export interface RescueOutcome {
  picks: AiPick[];
  /** 本次请求 LLM 覆盖是否达标 */
  llmRanked: boolean;
  /** topK 全部有分（整体完成） */
  completed: boolean;
  /** 本次匹配候选数（失败但 >0 = 部分结果已保留） */
  matched: number;
  marketView: string;
  selectionLogic: string;
  portfolioRisk: string;
  coverage: number | null;
  degradation: string[];
}

/**
 * 补救重排（增量续打）：对已保存的降级 Run，用后续用户的 token 继续打"缺分"候选的分。
 * - 部分保留：本次失败（llmRanked=false）也返回已匹配的分数（匹配 >0），由调用方写库
 * - 全部有分（completed=true）才算补救完成，调用方据此置 llmReranked=true 开启共享缓存
 */
export async function rescueRun(
  dbPicks: AiPick[],
  preset: StrategyPreset,
  cfg: LlmConfig,
): Promise<RescueOutcome | null> {
  if (dbPicks.length === 0) return null;
  const r = await rankCandidates(dbPicks, preset, cfg);
  let picks = r.picks;
  picks = applyRiskOverlay(picks, preset);
  picks = applyPortfolioOverlay(picks, preset);
  // 全部候选参与排序写库（尾部候选的 llm 字段也要保留），只标前 N 为选中
  for (const k of picks) {
    k.selected = false;
    k.rank = 0;
  }
  picks.slice(0, preset.maxOutput).forEach((k, i) => {
    k.selected = true;
    k.rank = i + 1;
  });
  return {
    picks,
    llmRanked: r.llmRanked,
    completed: r.completed,
    matched: r.matched,
    marketView: r.marketView,
    selectionLogic: r.selectionLogic,
    portfolioRisk: r.portfolioRisk,
    coverage: r.coverage,
    degradation: r.degradation,
  };
}
