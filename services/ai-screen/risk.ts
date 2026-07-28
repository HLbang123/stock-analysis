/**
 * AI 筛选 — 风险层 + 组合分散层
 *
 * 译自 alphasift risk.py，删 PE/PB/日线数据质量相关风险点（本项目无该数据）；新增筹码高位套牢风险点。
 * 风险层独立于总分：累加风险点 → 封顶扣分 → 可选一票否决。
 * 组合层：LLM 标的 sector 映射到风险桶，同桶超配递增扣分（封顶 3 倍步长）。
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

/** 行业规范化别名（译自 risk.py:248-266） */
const SECTOR_ALIASES: Record<string, string[]> = {
  券商: ['券商', '证券'],
  银行: ['银行'],
  保险: ['保险'],
  地产: ['地产', '房地产'],
  医药: ['医药', '医疗', '创新药'],
  白酒: ['白酒', '酿酒'],
  半导体: ['半导体', '芯片'],
  AI算力: ['AI算力', '算力', '数据中心'],
  新能源: ['新能源', '光伏', '锂电', '电池'],
};

/** 默认风险桶（译自 risk.py:37-45） */
const DEFAULT_BUCKETS: Record<string, string[]> = {
  金融: ['券商', '银行', '保险', '金融'],
  地产链: ['地产', '房地产', '建材', '家居', '物业'],
  新能源: ['新能源', '光伏', '锂电', '电池', '储能'],
  AI算力: ['AI算力', '算力', '数据中心', '服务器', '光模块'],
  消费: ['白酒', '食品', '家电', '零售', '消费'],
  医药: ['医药', '医疗', '创新药'],
  半导体: ['半导体', '芯片'],
};

function canonicalSector(raw: string): string {
  const s = raw.slice(0, 40);
  for (const [canon, aliases] of Object.entries(SECTOR_ALIASES)) {
    if (aliases.some((a) => s.includes(a))) return canon;
  }
  return s;
}

function portfolioBucket(sector: string, theme: string, buckets: Record<string, string[]>): string {
  const text = `${sector} ${theme}`;
  for (const [bucket, kws] of Object.entries(buckets)) {
    if (kws.some((kw) => text.includes(kw))) return bucket;
  }
  return sector || '其他';
}

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

/** 组合分散层：同风险桶超配递增扣分 */
export function applyPortfolioOverlay(picks: AiPick[], preset: StrategyPreset): AiPick[] {
  const profile = preset.portfolioProfile;
  if (!profile) return picks;
  const maxSame = profile.maxSameBucket ?? 1;
  const step = profile.concentrationPenalty ?? 4;
  if (step <= 0) return picks;
  const buckets = { ...DEFAULT_BUCKETS, ...(profile.buckets ?? {}) };

  const sorted = [...picks].sort((a, b) => b.finalScore - a.finalScore);
  const counts: Record<string, number> = {};
  for (const k of sorted) {
    const sector = canonicalSector(k.llmSector || k.industry || '');
    const bucket = portfolioBucket(sector, k.llmTheme, buckets);
    counts[bucket] = (counts[bucket] ?? 0) + 1;
    const excess = counts[bucket] - maxSame;
    if (excess > 0) {
      const penalty = Math.min(step * excess, step * 3);
      k.portfolioPenalty = penalty;
      k.finalScore = Math.round((k.finalScore - penalty) * 10000) / 10000;
      if (!k.riskFlags.includes(`portfolio_sector_concentration:${bucket}`)) {
        k.riskFlags.push(`portfolio_sector_concentration:${bucket}`);
      }
    }
  }
  sorted.sort((a, b) => b.finalScore - a.finalScore);
  sorted.forEach((k, i) => (k.rank = i + 1));
  return sorted;
}
