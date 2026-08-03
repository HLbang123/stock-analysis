/**
 * 深度分析 — 结构化候选价位推算（数字分工）
 *
 * 用 K线/指标/筹码/规则结果算出目标价/止损/仓位候选区间，
 * 交给 verdict LLM 在区间内定夺具体值并解释。
 * 把"拍数字"从 LLM 弱项交给结构化推算，LLM 只做定性判断+叙事。
 */

import type { KLineData, IndicatorResult, RuleCheckResult, RealtimeQuote } from '@/types';
import type { ChipDistribution } from '@/lib/chip';

export interface PriceRange {
  low: number;
  high: number;
}

export type MarketRegime = 'strong' | 'neutral' | 'weak';

export interface TradeLevels {
  currentPrice: number;
  atr: number;
  atrPct: number;
  stopLossRange: PriceRange;
  targetRange: PriceRange;
  positionRange: PriceRange; // 百分比 0-100
  marketRegime: MarketRegime;
  supports: PriceLevel[];     // 下方支撑（近→远）
  resistances: PriceLevel[];  // 上方压力（近→远）
  rationale: string;
}

const ATR_PERIOD = 14;
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface PriceLevel { price: number; label: string; }
export interface SupportResistance { current: number; supports: PriceLevel[]; resistances: PriceLevel[]; }

function smaCloses(kLines: KLineData[], n: number): number | null {
  if (kLines.length < n) return null;
  const seg = kLines.slice(-n);
  return seg.reduce((s, k) => s + k.close, 0) / n;
}

/** 黄金分割回撤位（经典三档 0.382/0.5/0.618），基于最近 window 日 high/low 波段 */
export function fibonacciLevels(kLines: KLineData[], window = 60): PriceLevel[] {
  if (kLines.length < window) return [];
  const seg = kLines.slice(-window);
  const high = Math.max(...seg.map(k => k.high));
  const low = Math.min(...seg.map(k => k.low));
  if (!(high > low)) return [];
  const range = high - low;
  return [0.382, 0.5, 0.618].map(r => ({
    price: Math.round((high - range * r) * 100) / 100,
    label: `${(r * 100).toFixed(1).replace(/\.0$/, '')}%回撤`,
  }));
}

/** 轻量支撑/压力位（结构位 + 黄金分割），供个股页支撑压力位卡片 / K线叠加线 */
export function computeSupportResistance(kLines: KLineData[], chip?: ChipDistribution | null): SupportResistance {
  const current = kLines[kLines.length - 1]?.close ?? 0;
  const last20 = kLines.slice(-20);
  const last60 = kLines.slice(-60);
  const low20 = last20.length ? Math.min(...last20.map(k => k.low)) : current;
  const high20 = last20.length ? Math.max(...last20.map(k => k.high)) : current;
  const low60 = last60.length ? Math.min(...last60.map(k => k.low)) : low20;
  const high60 = last60.length ? Math.max(...last60.map(k => k.high)) : high20;
  const ma20 = smaCloses(kLines, 20);
  const ma55 = smaCloses(kLines, 55);

  const candidates: PriceLevel[] = [
    ...(ma20 != null ? [{ price: ma20, label: 'MA20' }] : []),
    ...(ma55 != null ? [{ price: ma55, label: 'MA55' }] : []),
    { price: low20, label: '近20日低' },
    { price: high20, label: '近20日高' },
    ...(last60.length ? [{ price: low60, label: '近60日低' }, { price: high60, label: '近60日高' }] : []),
    ...(chip?.dominantPeak && chip.dominantPeak > 0 ? [{ price: chip.dominantPeak, label: '筹码主峰' }] : []),
    ...(chip?.peaks && chip.peaks.length > 0 ? chip.peaks.slice(0, 3).map((p, i) => ({ price: p, label: `筹码峰${i + 1}` })) : []),
    ...fibonacciLevels(kLines, 60),
  ];

  const dedup = (arr: PriceLevel[]): PriceLevel[] => {
    const seen = new Set<number>();
    return arr.filter(l => { const key = Math.round(l.price * 100); if (seen.has(key)) return false; seen.add(key); return true; });
  };
  return {
    current,
    supports: dedup(candidates.filter(l => l.price < current)).sort((a, b) => b.price - a.price).slice(0, 4),
    resistances: dedup(candidates.filter(l => l.price > current)).sort((a, b) => a.price - b.price).slice(0, 4),
  };
}

/** ATR(14)：TR = max(high-low, |high-prevClose|, |low-prevClose|)，SMA(14) */
function calcATR(kLines: KLineData[]): number {
  if (kLines.length < 3) return 0;
  const trs: number[] = [];
  for (let i = 1; i < kLines.length; i++) {
    const cur = kLines[i];
    const prev = kLines[i - 1];
    trs.push(Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close)
    ));
  }
  const slice = trs.slice(-ATR_PERIOD);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

/** 从 engineResults 解析 R11 箱体上沿 */
function extractBoxHigh(engineResults: RuleCheckResult[]): number | null {
  for (const r of engineResults) {
    if (!r.triggered || r.ruleId !== 'R11' || !r.extraData) continue;
    try {
      const d = JSON.parse(r.extraData);
      if (d.type === 'breakout' && typeof d.boxHigh === 'number') return d.boxHigh;
    } catch { /* ignore */ }
  }
  return null;
}

/** 买入类规则触发数（仓位基准用） */
function countBuySignals(engineResults: RuleCheckResult[]): number {
  const buyIds = new Set(['R05', 'R06', 'R09', 'R10', 'R11', 'R12', 'R13']);
  return engineResults.filter(r => r.triggered && r.ruleId && buyIds.has(r.ruleId)).length;
}

export function computeKeyLevels(params: {
  kLines: KLineData[];
  indicators: IndicatorResult;
  chip: ChipDistribution | null;
  engineResults: RuleCheckResult[];
  quote: RealtimeQuote;
  rps250?: number | null;
  positionPercent?: number;
  marketRegime?: MarketRegime;
}): TradeLevels {
  const { kLines, indicators, chip, engineResults, quote, rps250, positionPercent, marketRegime = 'neutral' } = params;
  const price = quote.price || indicators.lastClose || kLines.at(-1)?.close || 0;
  const recent = kLines.slice(-60);

  const atr = calcATR(kLines);
  const atrPct = price > 0 ? atr / price : 0;
  // 有效 ATR：K线不足时退化为 3% 波动率，避免区间坍缩
  const effAtr = atr > 0 ? atr : price * 0.03;

  const recentHigh = recent.length > 0 ? Math.max(...recent.map(k => k.high)) : price;
  const recentLow = recent.length > 0 ? Math.min(...recent.map(k => k.low)) : price;
  const low5 = kLines.length >= 5 ? Math.min(...kLines.slice(-5).map(k => k.low)) : recentLow;

  // --- 支撑位候选（止损参考，均 < 现价）---
  const supports: { price: number; label: string }[] = [];
  if (low5 > 0 && low5 < price) supports.push({ price: low5, label: `近5日低点${round2(low5)}` });
  if (indicators.ma55 > 0 && indicators.ma55 < price) supports.push({ price: indicators.ma55, label: `MA55 ${round2(indicators.ma55)}` });
  if (chip && chip.dominantPeak > 0 && chip.dominantPeak < price) supports.push({ price: chip.dominantPeak, label: `筹码主峰${round2(chip.dominantPeak)}` });
  if (recentLow > 0 && recentLow < price) supports.push({ price: recentLow, label: `近60日低点${round2(recentLow)}` });
  if (indicators.bollinger.lower > 0 && indicators.bollinger.lower < price) supports.push({ price: indicators.bollinger.lower, label: `布林下轨${round2(indicators.bollinger.lower)}` });

  // --- 压力位候选（目标参考，均 > 现价）---
  const resistances: { price: number; label: string }[] = [];
  if (recentHigh > price) resistances.push({ price: recentHigh, label: `近60日高点${round2(recentHigh)}` });
  const boxHigh = extractBoxHigh(engineResults);
  if (boxHigh && boxHigh > price) resistances.push({ price: boxHigh, label: `箱体上沿${round2(boxHigh)}` });
  if (chip && chip.peaks && chip.peaks.length > 0) {
    const upper = chip.peaks.filter(p => p > price).sort((a, b) => a - b);
    if (upper.length > 0) resistances.push({ price: upper[0], label: `上方套牢峰${round2(upper[0])}` });
  }
  if (indicators.bollinger.upper > price) resistances.push({ price: indicators.bollinger.upper, label: `布林上轨${round2(indicators.bollinger.upper)}` });

  // 黄金分割回撤位（60日波段，经典三档）并入候选
  const fib = fibonacciLevels(kLines, 60);
  supports.push(...fib.filter(l => l.price < price));
  resistances.push(...fib.filter(l => l.price > price));

  // --- 止损区间 [远端(容错大), 近端(止损小)]，落在支撑附近、1~2 ATR ---
  const stopFar = Math.max(recentLow > 0 ? recentLow : price - 2 * effAtr, price - 2 * effAtr);
  const stopNearRaw = Math.min(low5 > 0 ? low5 : price - effAtr, price - effAtr);
  const stopNear = Math.max(stopNearRaw, price - 1.5 * effAtr); // 近端不至过近
  const stopLossRange = stopFar < stopNear
    ? { low: round2(stopFar), high: round2(stopNear) }
    : { low: round2(price - 2 * effAtr), high: round2(price - effAtr) };

  // --- 目标区间 [近端(保守), 远端(激进)]，看压力位 ---
  const minResist = resistances.length > 0 ? Math.min(...resistances.map(r => r.price)) : price + 2 * effAtr;
  const maxResist = resistances.length > 0 ? Math.max(...resistances.map(r => r.price)) : price + 3 * effAtr;
  const targetNear = Math.max(price + 1.5 * effAtr, minResist);
  const targetFar = Math.max(maxResist, targetNear * 1.05);
  const targetRange = { low: round2(targetNear), high: round2(targetFar) };

  // --- 仓位区间 [low%, high%] ---
  const buyCount = countBuySignals(engineResults);
  let base: number;
  if (buyCount >= 2 && (rps250 ?? 0) >= 90) base = 40;
  else if (buyCount >= 1) base = 30;
  else base = 20;
  if (atrPct > 0.05) base *= 0.8;
  else if (atrPct < 0.02) base *= 1.1;
  // 市场状态联动：强势加仓、弱势压低
  const regimeFactor = marketRegime === 'strong' ? 1.2 : marketRegime === 'weak' ? 0.6 : 1.0;
  base *= regimeFactor;
  let posLow = base * 0.7;
  let posHigh = base * 1.2;
  if (positionPercent !== undefined && positionPercent > 0) {
    posHigh = Math.min(posHigh, Math.max(10, 50 - positionPercent));
  }
  posLow = Math.max(10, Math.min(posLow, 50));
  posHigh = Math.max(posLow, Math.min(posHigh, 50));
  const positionRange = { low: Math.round(posLow), high: Math.round(posHigh) };

  const regimeLabel = marketRegime === 'strong' ? '强势' : marketRegime === 'weak' ? '弱势' : '震荡';
  const rationale = [
    `当前价 ${round2(price)}，ATR(14) ${round2(atr)}（${(atrPct * 100).toFixed(1)}% 波动率）`,
    `市场状态：${regimeLabel}（仓位基准 ×${regimeFactor.toFixed(1)}）`,
    `止损区间 [${stopLossRange.low}, ${stopLossRange.high}] —— 依据：${supports.map(s => s.label).join(' / ') || '纯 ATR 推算'}`,
    `目标区间 [${targetRange.low}, ${targetRange.high}] —— 依据：${resistances.map(r => r.label).join(' / ') || '纯 ATR 推算'}`,
    `仓位区间 [${positionRange.low}%, ${positionRange.high}%] —— 买入类信号 ${buyCount} 条，RPS250 ${rps250 ?? '--'}，基准 ${Math.round(base)}%`,
  ].join('\n');

  // 展示用：去重 + 按距现价排序（支撑近→远降序、压力近→远升序），每侧最多 4 个
  const dedupSort = (arr: { price: number; label: string }[], desc: boolean): PriceLevel[] => {
    const seen = new Set<number>();
    const uniq = arr.filter(l => { const key = Math.round(l.price * 100); if (seen.has(key)) return false; seen.add(key); return true; });
    return (desc ? uniq.sort((a, b) => b.price - a.price) : uniq.sort((a, b) => a.price - b.price)).slice(0, 4);
  };

  return {
    currentPrice: round2(price), atr: round2(atr), atrPct, stopLossRange, targetRange, positionRange, marketRegime,
    supports: dedupSort(supports, true),
    resistances: dedupSort(resistances, false),
    rationale,
  };
}

/** 渲染成注入 verdict 的文本块（拼在 ## 分析师报告 之前，route 切分保留） */
export function formatLevelsForPrompt(levels: TradeLevels): string {
  return `## 结构化候选价位（规则引擎推算，请在区间内定夺）\n${levels.rationale}`;
}
