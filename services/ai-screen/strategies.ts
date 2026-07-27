/**
 * AI 筛选 — 策略预设
 *
 * Phase 1 硬编码 4 个预设（均衡/动量/质量/防守），后期可改 DB 驱动 + UI 编辑。
 * factor_weights 不必归一，引擎内 _normalizeFactorWeights 会归一。
 * 数据约束：无 PE/PB/市值/换手率，故价值因子改用 quality（ROE+毛利率+营收增速）。
 */

import type { StrategyPreset } from './types';

export const STRATEGY_PRESETS: StrategyPreset[] = [
  {
    id: 'balanced',
    name: '均衡筛选',
    description: '动量/质量/流动性/稳定性均衡，适合震荡市找中线标的',
    category: 'balanced',
    hardFilters: {
      excludeSt: true,
      rpsMin: 80,
      rpsPeriod: 60,
      amountMin: 50_000_000, // 5 千万成交额
      priceMin: 2,
      changePctMin: -9.5,
      changePctMax: 9.5,
      change60dMax: 60,
      requireMaBullish: false,
      volatility20dPctMax: 55,
      maxDrawdown20dPctMin: -18,
    },
    factorWeights: {
      momentum: 0.24,
      quality: 0.22,
      liquidity: 0.16,
      stability: 0.16,
      activity: 0.10,
      reversal: 0.06,
      theme_heat: 0.06,
    },
    rankingHints: [
      '优先关注：',
      '1. RPS 与 60 日涨幅领先、但未严重过热的标的',
      '2. 基本面扎实（ROE、毛利率、营收增速靠前）',
      '3. 流动性充足、波动与回撤可控',
      '4. 主题热度可加分但不作为唯一依据',
    ].join('\n'),
    maxOutput: 10,
    llmRerank: true,
    portfolioProfile: { maxSameBucket: 2, concentrationPenalty: 3.5 },
  },
  {
    id: 'momentum',
    name: '动量突破',
    description: '强调 RPS 与趋势强度，找强势加速标的，波动容忍度高',
    category: 'momentum',
    hardFilters: {
      excludeSt: true,
      rpsMin: 87,
      rpsPeriod: 60,
      amountMin: 100_000_000,
      priceMin: 3,
      changePctMin: -5,
      changePctMax: 9.8,
      change60dMin: 5,
      requireMaBullish: true,
    },
    factorWeights: {
      momentum: 0.42,
      activity: 0.18,
      liquidity: 0.14,
      theme_heat: 0.12,
      quality: 0.08,
      stability: 0.04,
      reversal: 0.02,
    },
    scoringProfile: {
      momentum_chase_start_pct: 7.0,
      momentum_60d_overheat_pct: 55.0,
    },
    rankingHints: [
      '优先关注：',
      '1. RPS 高位、MA 多头排列、MACD 金叉或红柱放大',
      '2. 量价配合（放量上涨），量比适中',
      '3. 行业指数当日强势，主题热度上升',
      '4. 警惕连阳过热与单日追高，但允许较高波动',
    ].join('\n'),
    maxOutput: 10,
    llmRerank: true,
    portfolioProfile: { maxSameBucket: 2, concentrationPenalty: 4.0 },
  },
  {
    id: 'quality',
    name: '高质量',
    description: '重基本面（ROE/毛利率/营收增速），找优质回踩标的',
    category: 'quality',
    hardFilters: {
      excludeSt: true,
      rpsMin: 70,
      rpsPeriod: 120,
      amountMin: 60_000_000,
      priceMin: 3,
      changePctMin: -7,
      changePctMax: 7,
      volatility20dPctMax: 45,
      maxDrawdown20dPctMin: -12,
    },
    factorWeights: {
      quality: 0.36,
      stability: 0.22,
      momentum: 0.16,
      liquidity: 0.14,
      theme_heat: 0.06,
      activity: 0.04,
      reversal: 0.02,
    },
    scoringProfile: {
      stability_high_volatility_pct: 38.0,
      stability_max_drawdown_floor_pct: -10.0,
    },
    rankingHints: [
      '优先关注：',
      '1. ROE、毛利率、营收增速在候选池中领先',
      '2. 波动率与回撤可控，日线数据质量高',
      '3. RPS 中上、趋势稳健，非短线爆炒',
      '4. 估值/热度可参考但不作为主依据',
    ].join('\n'),
    maxOutput: 10,
    llmRerank: true,
    portfolioProfile: { maxSameBucket: 2, concentrationPenalty: 3.0 },
  },
  {
    id: 'defensive',
    name: '低波防守',
    description: '低波动/低回撤优先，适合防守型观察仓',
    category: 'defensive',
    hardFilters: {
      excludeSt: true,
      rpsMin: 65,
      rpsPeriod: 60,
      amountMin: 80_000_000,
      priceMin: 4,
      changePctMin: -4,
      changePctMax: 5,
      change60dMax: 35,
      volatility20dPctMax: 32,
      maxDrawdown20dPctMin: -8,
    },
    factorWeights: {
      stability: 0.34,
      quality: 0.22,
      liquidity: 0.16,
      momentum: 0.14,
      theme_heat: 0.06,
      activity: 0.06,
      reversal: 0.02,
    },
    scoringProfile: {
      stability_high_volatility_pct: 30.0,
      stability_max_drawdown_floor_pct: -8.0,
      stability_high_atr_pct: 4.2,
      momentum_chase_start_pct: 4.0,
    },
    riskProfile: {
      chase_change_pct: 5.5,
      abnormal_volume_ratio: 4.5,
    },
    rankingHints: [
      '优先关注：',
      '1. 20 日波动与 ATR 较低、最大回撤可控',
      '2. 基本面稳健、流动性充足',
      '3. 主题热度可加分但不覆盖稳定性约束',
      '4. 规避单日大涨大跌与异常放量',
    ].join('\n'),
    maxOutput: 10,
    llmRerank: true,
    portfolioProfile: { maxSameBucket: 1, concentrationPenalty: 3.5 },
  },
];

export function getPreset(id: string): StrategyPreset | undefined {
  return STRATEGY_PRESETS.find((s) => s.id === id);
}
