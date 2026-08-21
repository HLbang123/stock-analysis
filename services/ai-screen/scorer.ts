/**
 * AI 筛选 — 因子打分引擎(胜率优先重构)
 *
 * 设计原则:每个因子独占一组不相交的原始信号,消除跨因子泄漏。
 * - trend    : ret60d / maBullish / macdStatus / volumeRatio / latestChange(趋势+量能确认,合并旧 momentum+activity)
 * - entry_timing : rsiStatus / pullbackToMa20Pct / latestChange(趋势中回踩入场,不追顶,直接服务胜率)
 * - risk     : volatility20d / maxDrawdown20d / atr20(纯波动控制,旧 stability 瘦身,不再碰 change/volume/signal)
 * - quality  : ROE / 毛利率 / 营收增速
 * - liquidity: log 成交额
 * - theme_heat: industryChangePct(板块级,与个股 trend 不重复)
 * - chip     : 筹码 4 子维度(低权待 IC 验证)
 *
 * signalScore 不再喂任何因子(它是 MA/MACD/RSI/量价的复合,喂因子会造成重复计数);
 * 它仍由 risk.ts 风险层读取,与因子打分解耦。
 *
 * 分段曲线参数默认值来自 DEFAULT_SCORING_PROFILE,可被 preset.scoringProfile 逐键覆盖。
 */

import type { AiPick, StrategyPreset } from './types';

/** 默认评分曲线参数 */
export const DEFAULT_SCORING_PROFILE: Record<string, number> = {
  // trend(趋势强度 + 量能确认)
  trend_base: 60.0,
  trend_intraday_slope: 5.0,
  trend_chase_start_pct: 5.0,
  trend_chase_penalty_slope: 10.0,
  trend_downside_start_pct: -2.0,
  trend_downside_penalty_slope: 3.0,
  trend_60d_base: 55.0,
  trend_60d_slope: 0.9,
  trend_60d_overheat_pct: 45.0,
  trend_60d_overheat_penalty_slope: 0.8,
  trend_60d_breakdown_pct: -20.0,
  trend_60d_breakdown_penalty_slope: 0.7,
  trend_ma_bullish_bonus: 8.0,
  trend_ma_bearish_penalty: 6.0,
  macd_bullish_bonus: 6.0,
  macd_bearish_penalty: 8.0,
  trend_ideal_volume_ratio: 2.0,
  trend_volume_distance_slope: 12.0,
  trend_high_volume_ratio: 5.0,
  trend_high_volume_penalty_slope: 6.0,
  // entry_timing(入场点)
  entry_timing_ideal_change_pct: -3.0,
  entry_timing_distance_slope: 13.0,
  entry_timing_collapse_start_pct: -8.0,
  entry_timing_collapse_slope: 10.0,
  entry_timing_chase_start_pct: 1.0,
  entry_timing_chase_slope: 8.0,
  entry_timing_ideal_pullback_pct: -3.0,
  entry_timing_pullback_distance_slope: 8.0,
  rsi_oversold_bonus: 10.0,
  rsi_overbought_penalty: 14.0,
  // risk(波动控制：20日波动率 + ATR；2026-08-15 删除回撤罚项——
  // 680天+10年两窗口 dd20 IC 稳定为正(momentum +0.045/+0.050, t=12)，深回撤=超跌反弹，罚它是反的)
  risk_base: 78.0,
  risk_high_volatility_pct: 45.0,
  risk_volatility_penalty_slope: 0.45,
  risk_high_atr_pct: 6.0,
  risk_atr_penalty_slope: 2.0,
  // theme_heat(板块风口)
  theme_heat_unknown_score: 50.0,
  theme_heat_change_slope: 6.0,
  theme_heat_overheat_score: 88.0,
  theme_heat_overheat_penalty_slope: 0.5,
};

function mergeProfile(preset: StrategyPreset): Record<string, number> {
  const out = { ...DEFAULT_SCORING_PROFILE };
  if (preset.scoringProfile) {
    for (const [k, v] of Object.entries(preset.scoringProfile)) {
      if (k in out) out[k] = v;
    }
  }
  return out;
}

const clip = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * 横截面百分位排名(0-100,高=好)。
 * lowerIsBetter=true 时小值得高分(如集中度低好)。NA 用 naScore 兜底。
 */
function rankScore(values: (number | null)[], lowerIsBetter: boolean, naScore: number): number[] {
  const n = values.length;
  const out = new Array(n).fill(naScore);
  const valid: { v: number; i: number }[] = [];
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v != null && !Number.isNaN(v)) valid.push({ v, i });
  }
  if (valid.length === 0) return out;
  const m = valid.length;
  valid.sort((a, b) => (lowerIsBetter ? a.v - b.v : b.v - a.v));
  for (let pos = 0; pos < m; pos++) {
    const pct = m === 1 ? 1 : (m - 1 - pos) / (m - 1);
    out[valid[pos].i] = clip(pct * 100, 0, 100);
  }
  return out;
}

/** 趋势强度 + 量能确认(合并旧 momentum + activity) */
function trend(picks: AiPick[], p: Record<string, number>): number[] {
  return picks.map((k) => {
    let score = p.trend_base;
    const ch = k.latestChange ?? 0;
    let intraday = 60 + ch * p.trend_intraday_slope;
    intraday -= Math.max(ch - p.trend_chase_start_pct, 0) * p.trend_chase_penalty_slope;
    intraday -= Math.max(-ch + p.trend_downside_start_pct, 0) * p.trend_downside_penalty_slope;
    intraday = clip(intraday, 5, 100);
    score = score * 0.35 + intraday * 0.65;

    if (k.ret60d != null) {
      let t60 = p.trend_60d_base + k.ret60d * p.trend_60d_slope;
      t60 -= Math.max(k.ret60d - p.trend_60d_overheat_pct, 0) * p.trend_60d_overheat_penalty_slope;
      t60 -= Math.max(-k.ret60d + p.trend_60d_breakdown_pct, 0) * p.trend_60d_breakdown_penalty_slope;
      t60 = clip(t60, 5, 100);
      score = score * 0.6 + t60 * 0.4;
    }

    // MACD 状态
    if (k.macdStatus === 'bullish') score += p.macd_bullish_bonus;
    else if (k.macdStatus === 'bearish') score -= p.macd_bearish_penalty;

    // 量能确认(合并自旧 activity):放量确认趋势,异常巨量罚
    const vr = k.volumeRatio ?? 1.0;
    let vrScore = 100 - Math.abs(vr - p.trend_ideal_volume_ratio) * p.trend_volume_distance_slope;
    vrScore -= Math.max(vr - p.trend_high_volume_ratio, 0) * p.trend_high_volume_penalty_slope;
    vrScore = clip(vrScore, 0, 100);
    score = score * 0.7 + vrScore * 0.3;

    return clip(score, 5, 100);
  });
}

/** 入场点:趋势中回踩入场,不追顶、不接崩塌(直接服务 T+5 胜率)。
 *  2026-08-21 起改池内横截面排名:绝对分在 RPS≥70 动量池内被压扁(绝大多数 ∈[5,25])，
 *  rankScore 单调变换展开到 0-100——Spearman IC 不变(10 年「唯一强正」结论保留)，
 *  同时让 screenScore 回归市场中性、门槛回归「质量地板」语义。 */
function entryTiming(picks: AiPick[], p: Record<string, number>): number[] {
  const raw = picks.map((k) => {
    const ch = k.latestChange;
    let score = 50;
    if (ch != null) {
      score = 100 - Math.abs(ch - p.entry_timing_ideal_change_pct) * p.entry_timing_distance_slope;
      score -= Math.max(-ch + p.entry_timing_collapse_start_pct, 0) * p.entry_timing_collapse_slope;
      score -= Math.max(ch - p.entry_timing_chase_start_pct, 0) * p.entry_timing_chase_slope;
    }
    // 距 MA20 回踩深度:理想略低于 MA20(-3%),过远(无论上下)罚
    if (k.pullbackToMa20Pct != null) {
      score -= Math.abs(k.pullbackToMa20Pct - p.entry_timing_ideal_pullback_pct) * p.entry_timing_pullback_distance_slope;
    }
    if (k.rsiStatus === 'oversold') score += p.rsi_oversold_bonus;
    else if (k.rsiStatus === 'overbought') score -= p.rsi_overbought_penalty;
    return clip(score, 5, 100);
  });
  return rankScore(raw, false, 50);
}

/** 波动控制(纯风险控制,旧 stability 瘦身:不再用 change/volume/signal/drawdown) */
function risk(picks: AiPick[], p: Record<string, number>): number[] {
  return picks.map((k) => {
    let score = p.risk_base;
    if (k.volatility20d != null) score -= Math.max(k.volatility20d - p.risk_high_volatility_pct, 0) * p.risk_volatility_penalty_slope;
    if (k.atr20 != null) score -= Math.max(k.atr20 - p.risk_high_atr_pct, 0) * p.risk_atr_penalty_slope;
    return clip(score, 0, 100);
  });
}

function quality(picks: AiPick[]): number[] {
  const roeRank = rankScore(picks.map((k) => k.roe), false, 40);
  const marginRank = rankScore(picks.map((k) => k.grossprofitMargin), false, 40);
  const yoyRank = rankScore(picks.map((k) => k.orYoy), false, 40);
  return picks.map((_, i) => {
    let score = 50;
    score = score * 0.5 + roeRank[i] * 0.5;
    score = score * 0.65 + marginRank[i] * 0.35;
    score = score * 0.8 + yoyRank[i] * 0.2;
    return clip(score, 0, 100);
  });
}

function liquidity(picks: AiPick[]): number[] {
  const logAmt = picks.map((k) => (k.latestAmount != null && k.latestAmount > 0 ? Math.log10(k.latestAmount) : null));
  const rank = rankScore(logAmt, false, 20);
  return rank.map((r) => clip(r, 0, 100));
}

function themeHeat(picks: AiPick[], p: Record<string, number>): number[] {
  return picks.map((k) => {
    let score = p.theme_heat_unknown_score;
    if (k.industryChangePct != null) {
      score = 50 + k.industryChangePct * p.theme_heat_change_slope;
    }
    score -= Math.max(score - p.theme_heat_overheat_score, 0) * p.theme_heat_overheat_penalty_slope;
    return clip(score, 0, 100);
  });
}

/**
 * 箱体形态二元因子（2026-08-15 十年回放验证后升级）：
 * 箱体内 vs 非箱体 T+5 +2~5pp、T+20 +7~9pp（RPS≥70/87 两口径一致）；
 * 但质量分非线性（<60 桶 +5.0pp 反而高于 ≥60 桶 +1.7pp）→ 只用 0/1，不喂连续分
 */
function box(picks: AiPick[]): number[] {
  return picks.map((k) => (k.boxQuality != null ? 100 : 0));
}

/**
 * 5/13 金叉二元因子（2026-08-21 引入）：规则健康表 R04 生产胜率显著；
 * 近 5 根内放量金叉 = 100 否则 0，与 box 同模式待 IC 验证。
 */
function cross13(picks: AiPick[]): number[] {
  return picks.map((k) => (k.cross13 ? 100 : 0));
}

/**
 * 筹码峰复合因子:4 子维度各自横截面排名后加权合成。
 * 子维度权重:集中度 0.3 / 获利盘 0.3 / 峰位 0.25 / 漂移 0.15
 */
function chip(picks: AiPick[]): number[] {
  const concRank = rankScore(picks.map((k) => k.chipConcentration), true, 50);
  const profitRank = rankScore(picks.map((k) => k.chipProfitRatio), false, 50);
  const peakPosRank = rankScore(picks.map((k) => k.chipPeakPos), false, 50);
  const driftRank = rankScore(picks.map((k) => k.chipPeakDrift), true, 50);
  return picks.map((_, i) => {
    const s = concRank[i] * 0.3 + profitRank[i] * 0.3 + peakPosRank[i] * 0.25 + driftRank[i] * 0.15;
    return clip(s, 0, 100);
  });
}

/** 归一化因子权重到总和 1 */
function normalizeWeights(weights: Record<string, number>): Record<string, number> {
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  if (total <= 0) {
    return { trend: 0.25, quality: 0.25, liquidity: 0.2, risk: 0.15, entry_timing: 0.1, theme_heat: 0.03, chip: 0.02 };
  }
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(weights)) out[k] = v / total;
  return out;
}

/**
 * 计算所有候选的因子分 + screenScore,写回 picks。
 * 纯加权求和(不加 conjunctive 门槛),权重由 IC 数据后续调优。
 */
export function computeScreenScores(picks: AiPick[], preset: StrategyPreset): void {
  if (picks.length === 0) return;
  const p = mergeProfile(preset);
  const weights = normalizeWeights(preset.factorWeights);

  const factorValues: Record<string, number[]> = {
    trend: trend(picks, p),
    entry_timing: entryTiming(picks, p),
    risk: risk(picks, p),
    quality: quality(picks),
    liquidity: liquidity(picks),
    theme_heat: themeHeat(picks, p),
    chip: chip(picks),
    box: box(picks),
    cross13: cross13(picks),
  };

  for (let i = 0; i < picks.length; i++) {
    const fs: Record<string, number> = {};
    let screen = 0;
    for (const key of Object.keys(factorValues)) {
      const v = factorValues[key][i];
      fs[key] = v;
      screen += v * (weights[key] ?? 0);
    }
    picks[i].factorScores = fs;
    picks[i].screenScore = clip(screen, 0, 100);
  }
}
