/**
 * 波段评分 — 确定性因子打分
 *
 * 镜像 services/ai-screen/scorer.ts 的 curve 打分模式，但单标的、无 cross-sectional rank。
 * 买入分 7 因子 + 卖出分 7 因子（均恒算；仓位信息仅作 LLM 上下文，不影响是否算卖点），各 curve 0-100，加权求和。
 * 因子信号尽量不相交：分时类读 IntradayContext，日级类读 ai-screen/indicators 派生量，
 * 信号类读 alertRules 触发结果。signalScore 类复合指标不喂因子（防泄漏）。
 * 做 T 规则（5分放量高抛 / 15分支撑低吸）权重 0.08，数据不足时因子取中性 50。
 */

import type { KLineData, RuleCheckResult } from '@/types';
import type { ChipDistribution } from '@/lib/chip';
import { calculateMA, calculateEMA, calcRSISeries } from '@/lib/indicators';
import { SELL_RULE_IDS } from '@/services/alertRules';
import type { IntradayContext } from './intraday';

// ===== 日级技术派生量（本地实现，避免引入 ai-screen/indicators → lib/chip → prisma 的客户端链） =====

function macdStatus(closes: number[]): string {
  if (closes.length < 35) return 'neutral';
  const ema12 = calculateEMA(closes, 12);
  const ema26 = calculateEMA(closes, 26);
  const n = closes.length;
  const dif = closes.map((_, i) => (Number.isNaN(ema12[i]) || Number.isNaN(ema26[i]) ? NaN : ema12[i] - ema26[i]));
  const dea = calculateEMA(dif, 9);
  const dNow = dif[n - 1], dPrev = dif[n - 2], eNow = dea[n - 1], ePrev = dea[n - 2];
  if (Number.isNaN(dNow) || Number.isNaN(dPrev) || Number.isNaN(eNow) || Number.isNaN(ePrev)) return 'neutral';
  if (dPrev <= ePrev && dNow > eNow) return 'bullish';
  if (dPrev >= ePrev && dNow < eNow) return 'bearish';
  return dNow > eNow ? 'bullish' : dNow < eNow ? 'bearish' : 'neutral';
}

function rsiStatus(closes: number[]): string {
  const series = calcRSISeries(closes, 14);
  const v = series[series.length - 1];
  if (v == null || Number.isNaN(v)) return 'neutral';
  if (v < 30) return 'oversold';
  if (v > 70) return 'overbought';
  return 'neutral';
}

function maBullish(closes: number[]): boolean | null {
  if (closes.length < 55) return null;
  const ma5 = calculateMA(closes, 5);
  const ma13 = calculateMA(closes, 13);
  const ma55 = calculateMA(closes, 55);
  const n = closes.length - 1;
  if (Number.isNaN(ma5[n]) || Number.isNaN(ma13[n]) || Number.isNaN(ma55[n])) return null;
  if (ma5[n] > ma13[n] && ma13[n] > ma55[n]) return true;
  if (ma5[n] < ma13[n] && ma13[n] < ma55[n]) return false;
  return false;
}

function pullbackToMa20Pct(closes: number[]): number | null {
  if (closes.length < 20) return null;
  const ma20 = calculateMA(closes, 20);
  const n = closes.length - 1;
  const m = ma20[n];
  const last = closes[n];
  if (Number.isNaN(m) || !m || !last) return null;
  return ((last - m) / m) * 100;
}

function breakout20dPct(closes: number[], highs: number[]): number | null {
  const n = closes.length;
  if (n < 2 || highs.length !== n) return null;
  const start = Math.max(0, n - 20);
  let hi = -Infinity;
  for (let i = start; i < n - 1; i++) hi = Math.max(hi, highs[i]);
  if (!Number.isFinite(hi) || hi <= 0) return null;
  return ((closes[n - 1] - hi) / hi) * 100;
}

/** CRITICAL 级卖出规则（R02/R04/R08），触发时买入分兜底 */
const CRITICAL_SELL_IDS = new Set(['R02', 'R04', 'R08']);

/** curve 参数（初始占位，后续可按 T+N 回测迭代） */
export const DEFAULT_TSCORE_PROFILE: Record<string, number> = {
  // 买·回踩 VWAP
  buy_vwap_ideal: -0.4,
  buy_vwap_slope: 14,
  buy_vwap_collapse_start: -2.0,
  buy_vwap_collapse_slope: 12,
  // 买·日内位置
  buy_range_ideal: 25,
  buy_range_slope: 1.4,
  buy_range_chase_start: 75,
  buy_range_chase_slope: 1.2,
  buy_range_collapse_start: 8,
  buy_range_collapse_slope: 3.0,
  // 买·缩量回踩
  buy_pvc_base: 70,
  buy_pvc_downvol_slope: 100,
  buy_pvc_tail_slope: 40,
  // 买·分时动量
  buy_mom_ideal: -0.8,
  buy_mom_slope: 10,
  buy_mom_collapse_start: -3.0,
  buy_mom_collapse_slope: 14,
  // 买·日级趋势
  buy_trend_base: 55,
  buy_trend_ma_bullish_bonus: 8,
  buy_trend_ma_bearish_penalty: 6,
  buy_trend_macd_bullish_bonus: 6,
  buy_trend_macd_bearish_penalty: 8,
  buy_daily_pullback_ideal: -3,
  buy_daily_pullback_slope: 8,
  buy_daily_pullback_breakdown: -8,
  buy_daily_pullback_breakdown_cap: 25,
  // 买·无卖出信号
  buy_signal_sell_penalty: 35,
  buy_signal_buy_bonus: 12,
  buy_signal_critical_floor: 15,
  // 卖·高于 VWAP
  sell_vwap_ideal: 1.2,
  sell_vwap_slope: 12,
  sell_vwap_overext_start: 3.5,
  sell_vwap_overext_slope: 14,
  sell_vwap_below_penalty: 20,
  // 卖·日内高位
  sell_range_ideal: 82,
  sell_range_slope: 1.4,
  sell_range_collapse_start: 97,
  sell_range_collapse_slope: 4,
  // 卖·放量上涨
  sell_rvs_base: 50,
  sell_rvs_upvol_slope: 60,
  sell_rvs_latesurge_slope: 40,
  // 卖·分时动量
  sell_mom_ideal: 1.0,
  sell_mom_slope: 10,
  sell_mom_collapse_start: 4.0,
  sell_mom_collapse_slope: 16,
  // 卖·日级过热近阻力
  sell_overheat_base: 55,
  sell_overheat_rsi_overbought_bonus: 12,
  sell_overheat_rsi_oversold_penalty: 10,
  sell_overheat_breakout_bonus: 10,
  sell_overheat_chip_above_peak_bonus: 8,
  sell_overheat_far_below_ma_penalty: 12,
  // 卖·卖出信号触发
  sell_signal_base: 60,
  sell_signal_sell_bonus: 25,
  // 买·15分K支撑位低吸（做T规则，低权重）
  buy_m15_slope: 20,           // 离支撑越近越高：dist=0→100, dist=2→60
  buy_m15_breakdown: 25,       // 跌破支撑兜底
  // 卖·5分K放大量高抛（做T规则，低权重）
  sell_m5_base: 45,
  sell_m5_surge_slope: 30,     // 放量倍数(r-1)加分：r=2→75, r=3→100
};

const BUY_WEIGHTS: Record<string, number> = {
  intradayPullbackToVwap: 0.18,   // 0.22→0.18，让 0.04 给做T规则
  intradayRangeLow: 0.18,
  pullbackVolumeContraction: 0.15,
  intradayMomentum: 0.10,
  dailyTrendUp: 0.16,             // 0.20→0.16，让 0.04 给做T规则
  noStrongSellSignal: 0.15,
  intradayM15Support: 0.08,       // 做T·15分K支撑位低吸（低权重）
};

const SELL_WEIGHTS: Record<string, number> = {
  intradayExtensionAboveVwap: 0.18,   // 0.22→0.18
  intradayRangeHigh: 0.18,
  riseVolumeSurge: 0.15,
  intradayMomentum: 0.10,
  dailyOverheatNearResistance: 0.16,  // 0.20→0.16
  strongSellSignalTriggered: 0.15,
  intradayM5VolSurge: 0.08,           // 做T·5分K放大量高抛（低权重）
};

const clip = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

export interface TFactorScore {
  name: string;
  score: number;
  weight: number;
  raw: Record<string, number>;
}

export interface TScoreInput {
  intraday: IntradayContext;
  engineResults: RuleCheckResult[];
  chip: ChipDistribution | null;
  kLines: KLineData[]; // 日 K（升序）
}

export interface TScoreResult {
  buyScore: number;
  sellScore: number;
  buyFactors: TFactorScore[];
  sellFactors: TFactorScore[];
  degraded: boolean;
  degradation: string[];
}

// ===== 买入因子 =====

function buyPullbackToVwap(ctx: IntradayContext, p: typeof DEFAULT_TSCORE_PROFILE): number {
  const d = ctx.vwapDevPct;
  let s = 100 - Math.abs(d - p.buy_vwap_ideal) * p.buy_vwap_slope;
  if (d < p.buy_vwap_collapse_start) s -= Math.abs(d - p.buy_vwap_collapse_start) * p.buy_vwap_collapse_slope;
  return clip(s);
}

function buyRangeLow(ctx: IntradayContext, p: typeof DEFAULT_TSCORE_PROFILE): number {
  const r = ctx.rangePosPct;
  let s = 100 - Math.abs(r - p.buy_range_ideal) * p.buy_range_slope;
  if (r > p.buy_range_chase_start) s -= (r - p.buy_range_chase_start) * p.buy_range_chase_slope;
  if (r < p.buy_range_collapse_start) s -= (p.buy_range_collapse_start - r) * p.buy_range_collapse_slope;
  return clip(s);
}

function buyVolumeContraction(ctx: IntradayContext, p: typeof DEFAULT_TSCORE_PROFILE): number {
  // downVolRatio 低=健康；尾盘(last5VolRatio)低=缩量健康，高=分销罚
  const s = p.buy_pvc_base - (ctx.downVolRatio - 0.4) * p.buy_pvc_downvol_slope + (1 - ctx.last5VolRatio) * p.buy_pvc_tail_slope;
  return clip(s);
}

function buyMomentum(ctx: IntradayContext, p: typeof DEFAULT_TSCORE_PROFILE): number {
  const m = ctx.mom15;
  let s = 100 - Math.abs(m - p.buy_mom_ideal) * p.buy_mom_slope;
  if (m < p.buy_mom_collapse_start) s -= Math.abs(m - p.buy_mom_collapse_start) * p.buy_mom_collapse_slope;
  return clip(s);
}

function buyDailyTrend(closes: number[], highs: number[], p: typeof DEFAULT_TSCORE_PROFILE): number {
  const mab = maBullish(closes);
  const macd = macdStatus(closes);
  let trendComp = p.buy_trend_base;
  if (mab === true) trendComp += p.buy_trend_ma_bullish_bonus;
  else if (mab === false) trendComp -= p.buy_trend_ma_bearish_penalty;
  if (macd === 'bullish') trendComp += p.buy_trend_macd_bullish_bonus;
  else if (macd === 'bearish') trendComp -= p.buy_trend_macd_bearish_penalty;
  trendComp = clip(trendComp);

  const pb = pullbackToMa20Pct(closes);
  let pullbackComp = 50;
  if (pb != null) {
    pullbackComp = 100 - Math.abs(pb - p.buy_daily_pullback_ideal) * p.buy_daily_pullback_slope;
    if (pb < p.buy_daily_pullback_breakdown) pullbackComp = Math.min(pullbackComp, p.buy_daily_pullback_breakdown_cap);
  }
  return clip(0.5 * trendComp + 0.5 * clip(pullbackComp));
}

function buyNoSellSignal(engineResults: RuleCheckResult[], p: typeof DEFAULT_TSCORE_PROFILE): number {
  let nSell = 0;
  let nBuy = 0;
  let critical = false;
  for (const r of engineResults) {
    if (!r.ruleId) continue;
    if (SELL_RULE_IDS.has(r.ruleId)) {
      nSell++;
      if (CRITICAL_SELL_IDS.has(r.ruleId)) critical = true;
    } else {
      nBuy++;
    }
  }
  let s = 100 - nSell * p.buy_signal_sell_penalty + nBuy * p.buy_signal_buy_bonus;
  s = clip(s);
  if (critical) s = Math.min(s, p.buy_signal_critical_floor);
  return s;
}

// 买·15分K支撑位低吸（做T规则）：15分K收盘贴近前期15分低点=回踩支撑→低吸
function buyM15Support(ctx: IntradayContext, p: typeof DEFAULT_TSCORE_PROFILE): number {
  const d = ctx.m15SupportDistPct;
  if (d == null) return 50; // 15分K根数不足，中性
  if (d < 0) return p.buy_m15_breakdown; // 跌破支撑，不低吸
  return clip(100 - d * p.buy_m15_slope); // 0=贴支撑→100，越远越低
}

// ===== 卖出因子 =====

function sellExtensionAboveVwap(ctx: IntradayContext, p: typeof DEFAULT_TSCORE_PROFILE): number {
  const d = ctx.vwapDevPct;
  let s = 100 - Math.abs(d - p.sell_vwap_ideal) * p.sell_vwap_slope;
  if (d > p.sell_vwap_overext_start) s -= (d - p.sell_vwap_overext_start) * p.sell_vwap_overext_slope;
  if (d < 0) s -= p.sell_vwap_below_penalty;
  return clip(s);
}

function sellRangeHigh(ctx: IntradayContext, p: typeof DEFAULT_TSCORE_PROFILE): number {
  const r = ctx.rangePosPct;
  let s = 100 - Math.abs(r - p.sell_range_ideal) * p.sell_range_slope;
  if (r > p.sell_range_collapse_start) s -= (r - p.sell_range_collapse_start) * p.sell_range_collapse_slope;
  return clip(s);
}

function sellRiseVolumeSurge(ctx: IntradayContext, p: typeof DEFAULT_TSCORE_PROFILE): number {
  // up-volume 高(=downVolRatio 低) + 尾盘放量 = 可卖入
  const s = p.sell_rvs_base + (1 - ctx.downVolRatio) * p.sell_rvs_upvol_slope + (ctx.last5VolRatio - 1) * p.sell_rvs_latesurge_slope;
  return clip(s);
}

function sellMomentum(ctx: IntradayContext, p: typeof DEFAULT_TSCORE_PROFILE): number {
  const m = ctx.mom15;
  let s = 100 - Math.abs(m - p.sell_mom_ideal) * p.sell_mom_slope;
  if (m > p.sell_mom_collapse_start) s -= (m - p.sell_mom_collapse_start) * p.sell_mom_collapse_slope;
  return clip(s);
}

function sellDailyOverheat(closes: number[], highs: number[], chip: ChipDistribution | null, p: typeof DEFAULT_TSCORE_PROFILE): number {
  let s = p.sell_overheat_base;
  const rs = rsiStatus(closes);
  if (rs === 'overbought') s += p.sell_overheat_rsi_overbought_bonus;
  else if (rs === 'oversold') s -= p.sell_overheat_rsi_oversold_penalty;

  const bo = breakout20dPct(closes, highs);
  if (bo != null && bo >= 0) s += p.sell_overheat_breakout_bonus; // 站上/突破 20 日高
  if (chip && chip.peakPos > 0.1) s += p.sell_overheat_chip_above_peak_bonus; // 站上筹码主峰

  const pb = pullbackToMa20Pct(closes);
  if (pb != null && pb < -5) s -= p.sell_overheat_far_below_ma_penalty; // 远低于 MA20，无卖点
  return clip(s);
}

function sellStrongSignal(engineResults: RuleCheckResult[], p: typeof DEFAULT_TSCORE_PROFILE): number {
  let nSell = 0;
  for (const r of engineResults) {
    if (r.ruleId && SELL_RULE_IDS.has(r.ruleId)) nSell++;
  }
  let s = p.sell_signal_base + nSell * p.sell_signal_sell_bonus;
  if (nSell >= 1) s = Math.max(s, 50);
  if (nSell >= 2) s = Math.min(s, 95);
  return clip(s);
}

// 卖·5分K放大量高抛（做T规则）：最新5分K量显著放大且收阳=放量冲高→高抛
function sellM5VolSurge(ctx: IntradayContext, p: typeof DEFAULT_TSCORE_PROFILE): number {
  const r = ctx.m5VolSurgeRatio;
  if (r <= 0) return 50; // 5分K根数不足，中性
  let s = p.sell_m5_base;
  if (ctx.m5LastUp && r > 1) s += (r - 1) * p.sell_m5_surge_slope;
  return clip(s);
}

/** 主入口：算买入分 + 卖出分（均恒算；仓位信息仅作 LLM 上下文，不影响是否算卖点）。分时不足 → degraded。 */
export function computeTScore(input: TScoreInput): TScoreResult {
  const { intraday: ctx, engineResults, chip, kLines } = input;
  const p = DEFAULT_TSCORE_PROFILE;
  const degradation: string[] = [];

  if (!ctx.sufficient) {
    return { buyScore: 0, sellScore: 0, buyFactors: [], sellFactors: [], degraded: true, degradation: ['intraday_insufficient'] };
  }

  const closes = kLines.map((k) => k.close).filter((x) => Number.isFinite(x));
  const highs = kLines.map((k) => k.high).filter((x) => Number.isFinite(x));

  // 买入分
  const buyFactors: TFactorScore[] = [
    { name: '回踩VWAP', score: buyPullbackToVwap(ctx, p), weight: BUY_WEIGHTS.intradayPullbackToVwap, raw: { vwapDevPct: ctx.vwapDevPct } },
    { name: '日内低位', score: buyRangeLow(ctx, p), weight: BUY_WEIGHTS.intradayRangeLow, raw: { rangePosPct: ctx.rangePosPct } },
    { name: '缩量回踩', score: buyVolumeContraction(ctx, p), weight: BUY_WEIGHTS.pullbackVolumeContraction, raw: { downVolRatio: ctx.downVolRatio, last5VolRatio: ctx.last5VolRatio } },
    { name: '分时动量', score: buyMomentum(ctx, p), weight: BUY_WEIGHTS.intradayMomentum, raw: { mom15: ctx.mom15 } },
    { name: '日级趋势', score: buyDailyTrend(closes, highs, p), weight: BUY_WEIGHTS.dailyTrendUp, raw: {} },
    { name: '无卖出信号', score: buyNoSellSignal(engineResults, p), weight: BUY_WEIGHTS.noStrongSellSignal, raw: {} },
    { name: '15分支撑低吸', score: buyM15Support(ctx, p), weight: BUY_WEIGHTS.intradayM15Support, raw: { m15SupportDistPct: ctx.m15SupportDistPct ?? NaN } },
  ];
  // 买入分（权重存在各因子 weight 字段，直接归一）
  const buyWsum = buyFactors.reduce((a, f) => a + f.weight, 0);
  const buyScore = clip(buyFactors.reduce((a, f) => a + f.score * (f.weight / buyWsum), 0));

  // 卖出分（恒算；仓位未填不代表未持仓，卖点信号对任何人都可参考）
  const sellFactors: TFactorScore[] = [
    { name: '高于VWAP', score: sellExtensionAboveVwap(ctx, p), weight: SELL_WEIGHTS.intradayExtensionAboveVwap, raw: { vwapDevPct: ctx.vwapDevPct } },
    { name: '日内高位', score: sellRangeHigh(ctx, p), weight: SELL_WEIGHTS.intradayRangeHigh, raw: { rangePosPct: ctx.rangePosPct } },
    { name: '放量上涨', score: sellRiseVolumeSurge(ctx, p), weight: SELL_WEIGHTS.riseVolumeSurge, raw: { downVolRatio: ctx.downVolRatio, last5VolRatio: ctx.last5VolRatio } },
    { name: '分时动量', score: sellMomentum(ctx, p), weight: SELL_WEIGHTS.intradayMomentum, raw: { mom15: ctx.mom15 } },
    { name: '日级过热', score: sellDailyOverheat(closes, highs, chip, p), weight: SELL_WEIGHTS.dailyOverheatNearResistance, raw: {} },
    { name: '卖出信号', score: sellStrongSignal(engineResults, p), weight: SELL_WEIGHTS.strongSellSignalTriggered, raw: {} },
    { name: '5分放量高抛', score: sellM5VolSurge(ctx, p), weight: SELL_WEIGHTS.intradayM5VolSurge, raw: { m5VolSurgeRatio: ctx.m5VolSurgeRatio, m5LastUp: ctx.m5LastUp ? 1 : 0 } },
  ];
  const sellWsum = sellFactors.reduce((a, f) => a + f.weight, 0);
  const sellScore = clip(sellFactors.reduce((acc, f) => acc + f.score * (f.weight / sellWsum), 0));

  if (ctx.granularity === 'm5') degradation.push('minute_fallback_m5');

  return { buyScore: Math.round(buyScore), sellScore: Math.round(sellScore), buyFactors, sellFactors, degraded: false, degradation };
}
