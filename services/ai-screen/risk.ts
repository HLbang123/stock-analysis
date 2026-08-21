/**
 * AI 筛选 — 风险层
 *
 * 译自 alphasift risk.py，删 PE/PB/日线数据质量相关风险点（本项目无该数据）；新增筹码高位套牢风险点。
 * 风险层独立于总分：累加风险点 → 封顶扣分 → 可选一票否决。
 * （组合分散层 08-14 已随 portfolioProfile 移除，桶映射函数 08-21 一并清理。）
 */

import type { AiPick, StrategyPreset } from './types';

export const DEFAULT_RISK_PROFILE: Record<string, number> = {
  chase_change_pct: 8.0,
  chase_points: 4.0,
  breakdown_change_pct: -7.0,
  breakdown_points: 3.5,
  abnormal_volume_ratio: 6.0,
  abnormal_volume_ratio_points: 3.0,
  weak_signal_score: 45.0,
  weak_signal_points: 2.5,
  macd_bearish_points: 2.0,
  rsi_overbought_points: 1.5,
  low_llm_confidence: 0.35,
  low_llm_confidence_points: 1.5,
  llm_risk_points: 1.2,
  llm_risk_points_cap: 4.0,
  chip_high_trap_profit: 0.35,   // 获利盘比例低于此值
  chip_high_trap_peak_pos: -0.03, // 且主峰在当前价上方（套牢盘重）
  chip_high_trap_points: 1.5,
  max_penalty: 12.0,
};

function mergeRiskProfile(preset: StrategyPreset): Record<string, number> {
  const out = { ...DEFAULT_RISK_PROFILE };
  if (preset.riskProfile) {
    for (const [k, v] of Object.entries(preset.riskProfile)) {
      if (k in out) out[k] = v;
    }
  }
  return out;
}

/** 单只候选的风险点累加 */
function assessPickRisk(k: AiPick, p: Record<string, number>): { points: number; flags: string[] } {
  let points = 0;
  const flags: string[] = [];
  const ch = k.latestChange ?? 0;

  if (ch >= p.chase_change_pct) {
    points += p.chase_points;
    flags.push('single_day_chase_risk');
  } else if (ch <= p.breakdown_change_pct) {
    points += p.breakdown_points;
    flags.push('single_day_breakdown_risk');
  }
  if ((k.volumeRatio ?? 0) >= p.abnormal_volume_ratio) {
    points += p.abnormal_volume_ratio_points;
    flags.push('abnormal_volume_ratio');
  }
  if (k.signalScore != null && k.signalScore < p.weak_signal_score) {
    points += p.weak_signal_points;
    flags.push('weak_daily_signal');
  }
  if (k.macdStatus === 'bearish') {
    points += p.macd_bearish_points;
    flags.push('macd_bearish');
  }
  if (k.rsiStatus === 'overbought') {
    points += p.rsi_overbought_points;
    flags.push('rsi_overbought');
  }
  if (k.llmConfidence != null && k.llmConfidence < p.low_llm_confidence) {
    points += p.low_llm_confidence_points;
    flags.push('low_llm_confidence');
  }
  if (k.llmRisks.length > 0) {
    points += Math.min(k.llmRisks.length * p.llm_risk_points, p.llm_risk_points_cap);
    flags.push(...k.llmRisks);
  }
  // 筹码高位套牢：获利盘低 + 主峰在上方
  if (k.chipProfitRatio != null && k.chipProfitRatio < p.chip_high_trap_profit
      && k.chipPeakPos != null && k.chipPeakPos < p.chip_high_trap_peak_pos) {
    points += p.chip_high_trap_points;
    flags.push('chip_high_trap');
  }
  return { points, flags };
}

/** 风险层：扣分 + risk_level + 可选一票否决 */
export function applyRiskOverlay(picks: AiPick[], preset: StrategyPreset, vetoHighRisk = false): AiPick[] {
  const p = mergeRiskProfile(preset);
  const maxPenalty = p.max_penalty;
  if (maxPenalty <= 0) return picks;

  const kept: AiPick[] = [];
  for (const k of picks) {
    const { points, flags } = assessPickRisk(k, p);
    const penalty = Math.min(points, maxPenalty);
    k.riskPenalty = Math.round(penalty * 10000) / 10000;
    k.riskScore = Math.min((points / maxPenalty) * 100, 100);
    k.riskLevel = points >= maxPenalty * 0.66 ? 'high' : points >= maxPenalty * 0.33 ? 'medium' : 'low';
    k.riskFlags = Array.from(new Set(flags));
    k.finalScore = Math.round((k.finalScore - penalty) * 10000) / 10000;
    if (vetoHighRisk && k.riskLevel === 'high') {
      // 一票否决：跳过该候选
      continue;
    }
    kept.push(k);
  }
  kept.sort((a, b) => b.finalScore - a.finalScore);
  kept.forEach((k, i) => (k.rank = i + 1));
  return kept;
}

