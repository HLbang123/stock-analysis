/**
 * AI 筛选 — 因子打分引擎
 *
 * 译自 alphasift scorer.py，按本项目数据裁剪：
 * - 删 value(PE/PB) → 改 quality(ROE/毛利率/营收增速)
 * - 删 size(市值)、topic_alignment(需热点基建)
 * - 保留 momentum/liquidity/stability/activity/reversal/theme_heat
 * 分段曲线参数默认值来自 alphasift _DEFAULT_SCORING_PROFILE，可被 preset.scoringProfile 逐键覆盖。
 */

import type { AiPick, StrategyPreset } from './types';

/** 默认评分曲线参数（来自 alphasift scorer.py:19-87） */
export const DEFAULT_SCORING_PROFILE: Record<string, number> = {
  momentum_base: 60.0,
  momentum_intraday_slope: 5.0,
  momentum_chase_start_pct: 5.0,
  momentum_chase_penalty_slope: 10.0,
  momentum_downside_start_pct: -2.0,
  momentum_downside_penalty_slope: 3.0,
  momentum_60d_base: 55.0,
  momentum_60d_slope: 0.9,
  momentum_60d_overheat_pct: 45.0,
  momentum_60d_overheat_penalty_slope: 0.8,
  momentum_60d_breakdown_pct: -20.0,
  momentum_60d_breakdown_penalty_slope: 0.7,
  macd_bullish_bonus: 6.0,
  macd_bearish_penalty: 8.0,
  reversal_ideal_change_pct: -3.0,
  reversal_distance_penalty_slope: 13.0,
  reversal_collapse_start_pct: -8.0,
  reversal_collapse_penalty_slope: 10.0,
  reversal_chase_start_pct: 1.0,
  reversal_chase_penalty_slope: 8.0,
  rsi_oversold_bonus: 10.0,
  rsi_overbought_penalty: 14.0,
  activity_ideal_volume_ratio: 2.0,
  activity_volume_ratio_distance_slope: 15.0,
  activity_high_volume_ratio: 5.0,
  activity_high_volume_ratio_penalty_slope: 8.0,
  stability_base: 78.0,
  stability_change_abs_penalty_slope: 3.0,
  stability_hot_change_pct: 7.0,
  stability_hot_change_penalty_slope: 5.0,
  stability_high_volume_ratio: 5.0,
  stability_high_volume_ratio_penalty_slope: 4.0,
  stability_high_volatility_pct: 45.0,
  stability_high_volatility_penalty_slope: 0.45,
  stability_max_drawdown_floor_pct: -12.0,
  stability_drawdown_penalty_slope: 1.2,
  stability_high_atr_pct: 6.0,
  stability_high_atr_penalty_slope: 2.0,
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
 * 横截面百分位排名（0-100，高=好）。
 * lowerIsBetter=true 时小值得高分（如 PE 低好）。NA 用 naScore 兜底。
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
  // 让"更好"的值排在前面（pos=0 最佳）
  valid.sort((a, b) => (lowerIsBetter ? a.v - b.v : b.v - a.v));
  for (let pos = 0; pos < m; pos++) {
    const pct = m === 1 ? 1 : (m - 1 - pos) / (m - 1);
    out[valid[pos].i] = clip(pct * 100, 0, 100);
  }
  return out;
}

function momentum(picks: AiPick[], p: Record<string, number>): number[] {
  return picks.map((k) => {
    let score = p.momentum_base;
    const ch = k.latestChange ?? 0;
    let intraday = 60 + ch * p.momentum_intraday_slope;
    intraday -= Math.max(ch - p.momentum_chase_start_pct, 0) * p.momentum_chase_penalty_slope;
    intraday -= Math.max(-ch + p.momentum_downside_start_pct, 0) * p.momentum_downside_penalty_slope;
    intraday = clip(intraday, 5, 100);
    score = score * 0.35 + intraday * 0.65;

    if (k.ret60d != null) {
      let trend = p.momentum_60d_base + k.ret60d * p.momentum_60d_slope;
      trend -= Math.max(k.ret60d - p.momentum_60d_overheat_pct, 0) * p.momentum_60d_overheat_penalty_slope;
      trend -= Math.max(-k.ret60d + p.momentum_60d_breakdown_pct, 0) * p.momentum_60d_breakdown_penalty_slope;
      trend = clip(trend, 5, 100);
      score = score * 0.6 + trend * 0.4;
    }
    if (k.signalScore != null) {
      score = score * 0.7 + clip(k.signalScore, 0, 100) * 0.3;
    }
    if (k.macdStatus === 'bullish') score += p.macd_bullish_bonus;
    else if (k.macdStatus === 'bearish') score -= p.macd_bearish_penalty;
    return clip(score, 5, 100);
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

function activity(picks: AiPick[], p: Record<string, number>): number[] {
  return picks.map((k) => {
    let score = 50;
    const vr = k.volumeRatio ?? 1.0;
    let vrScore = 100 - Math.abs(vr - p.activity_ideal_volume_ratio) * p.activity_volume_ratio_distance_slope;
    vrScore -= Math.max(vr - p.activity_high_volume_ratio, 0) * p.activity_high_volume_ratio_penalty_slope;
    vrScore = clip(vrScore, 5, 100);
    score = score * 0.45 + vrScore * 0.55;
    return clip(score, 0, 100);
  });
}

function reversal(picks: AiPick[], p: Record<string, number>): number[] {
  return picks.map((k) => {
    const ch = k.latestChange;
    if (ch == null) return 50;
    let score = 100 - Math.abs(ch - p.reversal_ideal_change_pct) * p.reversal_distance_penalty_slope;
    score -= Math.max(-ch + p.reversal_collapse_start_pct, 0) * p.reversal_collapse_penalty_slope;
    score -= Math.max(ch - p.reversal_chase_start_pct, 0) * p.reversal_chase_penalty_slope;
    if (k.rsiStatus === 'oversold') score += p.rsi_oversold_bonus;
    else if (k.rsiStatus === 'overbought') score -= p.rsi_overbought_penalty;
    if (k.ret60d != null) {
      score -= Math.max(k.ret60d - 35, 0) * 0.5;
      score -= Math.max(-k.ret60d - 35, 0) * 0.8;
    }
    return clip(score, 5, 100);
  });
}

function stability(picks: AiPick[], p: Record<string, number>): number[] {
  return picks.map((k) => {
    let score = p.stability_base;
    const ch = k.latestChange ?? 0;
    score -= Math.min(Math.abs(ch), 10) * p.stability_change_abs_penalty_slope;
    score -= Math.max(ch - p.stability_hot_change_pct, 0) * p.stability_hot_change_penalty_slope;
    const vr = k.volumeRatio ?? 1;
    score -= Math.max(vr - p.stability_high_volume_ratio, 0) * p.stability_high_volume_ratio_penalty_slope;
    if (k.signalScore != null) score += (k.signalScore - 50) * 0.12;
    if (k.volatility20d != null) score -= Math.max(k.volatility20d - p.stability_high_volatility_pct, 0) * p.stability_high_volatility_penalty_slope;
    if (k.maxDrawdown20d != null) score -= Math.max(p.stability_max_drawdown_floor_pct - k.maxDrawdown20d, 0) * p.stability_drawdown_penalty_slope;
    if (k.atr20 != null) score -= Math.max(k.atr20 - p.stability_high_atr_pct, 0) * p.stability_high_atr_penalty_slope;
    return clip(score, 0, 100);
  });
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
 * 筹码峰复合因子：4 子维度各自横截面排名后加权合成。
 * 暧昧形态不设绝对阈值，靠相对排名吸收——比同类"更低位密集+获利盘高+站上主峰+峰位下移"得分更高。
 * 子维度权重：集中度 0.3 / 获利盘 0.3 / 峰位 0.25 / 漂移 0.15
 */
function chip(picks: AiPick[]): number[] {
  const concRank = rankScore(picks.map((k) => k.chipConcentration), true, 50);   // 越小越密集越好
  const profitRank = rankScore(picks.map((k) => k.chipProfitRatio), false, 50);  // 越高越好
  const peakPosRank = rankScore(picks.map((k) => k.chipPeakPos), false, 50);     // 站上主峰为正越好
  const driftRank = rankScore(picks.map((k) => k.chipPeakDrift), true, 50);      // 下移(负值)越好
  return picks.map((_, i) => {
    const s = concRank[i] * 0.3 + profitRank[i] * 0.3 + peakPosRank[i] * 0.25 + driftRank[i] * 0.15;
    return clip(s, 0, 100);
  });
}

/** 归一化因子权重到总和 1 */
function normalizeWeights(weights: Record<string, number>): Record<string, number> {
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  if (total <= 0) return { momentum: 0.25, quality: 0.25, liquidity: 0.2, stability: 0.2, activity: 0.1 };
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(weights)) out[k] = v / total;
  return out;
}

/**
 * 计算所有候选的因子分 + screenScore，写回 picks。
 * activity/theme_heat 等需要 profile 的因子单独传 p。
 */
export function computeScreenScores(picks: AiPick[], preset: StrategyPreset): void {
  if (picks.length === 0) return;
  const p = mergeProfile(preset);
  const weights = normalizeWeights(preset.factorWeights);

  const factorValues: Record<string, number[]> = {
    momentum: momentum(picks, p),
    quality: quality(picks),
    liquidity: liquidity(picks),
    activity: activity(picks, p),
    reversal: reversal(picks, p),
    stability: stability(picks, p),
    theme_heat: themeHeat(picks, p),
    chip: chip(picks),
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
