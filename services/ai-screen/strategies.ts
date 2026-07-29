/**
 * AI 筛选 — 策略预设(胜率优先重构)
 *
 * 4 个预设按论点重组因子权重(7 因子:trend/entry_timing/risk/quality/liquidity/theme_heat/chip)。
 * 权重为初始占位值,后续由 T+N 因子 IC 数据围绕 T+5 胜率迭代调优。
 * factor_weights 不必归一,引擎内 normalizeWeights 会归一。
 */

import type { StrategyPreset } from './types';

export const STRATEGY_PRESETS: StrategyPreset[] = [
  {
    id: 'balanced',
    name: '均衡筛选',
    description: '趋势向上+基本面不差+入场不追高+波动可控+流动性够,各项达标的中庸优选',
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
      trend: 0.30,
      quality: 0.20,
      risk: 0.15,
      entry_timing: 0.13,
      liquidity: 0.12,
      theme_heat: 0.05,
      chip: 0.05,
    },
    rankingHints: [
      '优先关注：',
      '1. 趋势向上(RPS、60 日涨幅、MA 多头、量价配合)但未严重过热',
      '2. 基本面扎实(ROE、毛利率、营收增速靠前)',
      '3. 入场点不追顶(回踩 MA20、RSI 不超买)',
      '4. 波动与回撤可控、流动性充足',
    ].join('\n'),
    rulesText: [
      '硬筛：RPS(60日)≥80 · 成交额≥5千万 · 单日涨跌±9.5% · 60日涨幅≤60% · 波动率≤55% · 回撤≥-18%',
      '因子侧重：趋势30% · 质量20% · 波动15% · 入场点13% · 流动性12% · 板块5% · 筹码5%',
      '组合约束：同方向最多2只',
    ].join('\n'),
    maxOutput: 10,
    llmRerank: true,
    portfolioProfile: { maxSameBucket: 2, concentrationPenalty: 3.5 },
  },
  {
    id: 'momentum',
    name: '动量突破',
    description: '强趋势+量能配合+板块主升,追强加速段,允许较高波动',
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
      trend: 0.50,
      theme_heat: 0.15,
      liquidity: 0.12,
      entry_timing: 0.10,
      quality: 0.08,
      risk: 0.03,
      chip: 0.02,
    },
    scoringProfile: {
      trend_chase_start_pct: 7.0,
      trend_60d_overheat_pct: 55.0,
    },
    rankingHints: [
      '优先关注：',
      '1. RPS 高位、MA 多头排列、MACD 金叉或红柱放大',
      '2. 量价配合(放量上涨),量比适中',
      '3. 行业指数当日强势,主题热度上升',
      '4. 警惕连阳过热与单日追高,但允许较高波动',
    ].join('\n'),
    rulesText: [
      '硬筛：RPS(60日)≥87 · 成交额≥1亿 · 单日-5%~+9.8% · 60日涨>5% · 必须MA5>MA13>MA55多头排列',
      '因子侧重：趋势50% · 板块15% · 流动性12% · 入场点10% · 质量8% · 波动3% · 筹码2%',
      '组合约束：同方向最多2只(允许较高波动,追强加速段)',
    ].join('\n'),
    maxOutput: 10,
    llmRerank: true,
    portfolioProfile: { maxSameBucket: 2, concentrationPenalty: 4.0 },
  },
  {
    id: 'quality',
    name: '高质量',
    description: '高 ROE/毛利率+趋势不差+回踩入场+波动可控,找优质回踩标的',
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
      quality: 0.34,
      trend: 0.18,
      entry_timing: 0.18,
      risk: 0.14,
      liquidity: 0.10,
      theme_heat: 0.04,
      chip: 0.02,
    },
    scoringProfile: {
      risk_high_volatility_pct: 38.0,
      risk_drawdown_floor_pct: -10.0,
    },
    rankingHints: [
      '优先关注：',
      '1. ROE、毛利率、营收增速在候选池中领先',
      '2. 入场点为优质回踩(回踩 MA20、RSI 不超买)',
      '3. 趋势稳健(RPS 中上、MA 多头),非短线爆炒',
      '4. 波动与回撤可控,日线数据质量高',
    ].join('\n'),
    rulesText: [
      '硬筛：RPS(120日)≥70 · 成交额≥6千万 · 单日-7%~+7% · 波动率≤45% · 回撤≥-12%',
      '因子侧重：质量34% · 趋势18% · 入场点18% · 波动14% · 流动性10% · 板块4% · 筹码2%',
      '组合约束：同方向最多2只(重基本面,找优质回踩)',
    ].join('\n'),
    maxOutput: 10,
    llmRerank: true,
    portfolioProfile: { maxSameBucket: 2, concentrationPenalty: 3.0 },
  },
  {
    id: 'defensive',
    name: '低波防守',
    description: '低波动/低回撤优先+基本面稳+流动性好,防守型观察仓',
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
      risk: 0.30,
      quality: 0.22,
      liquidity: 0.16,
      trend: 0.14,
      entry_timing: 0.10,
      theme_heat: 0.04,
      chip: 0.04,
    },
    scoringProfile: {
      risk_high_volatility_pct: 30.0,
      risk_drawdown_floor_pct: -8.0,
      risk_high_atr_pct: 4.2,
      trend_chase_start_pct: 4.0,
    },
    riskProfile: {
      chase_change_pct: 5.5,
      abnormal_volume_ratio: 4.5,
    },
    rankingHints: [
      '优先关注：',
      '1. 20 日波动与 ATR 较低、最大回撤可控',
      '2. 基本面稳健、流动性充足',
      '3. 入场点不追高(回踩、RSI 不超买)',
      '4. 规避单日大涨大跌与异常放量',
    ].join('\n'),
    rulesText: [
      '硬筛：RPS(60日)≥65 · 成交额≥8千万 · 单日-4%~+5% · 60日涨≤35% · 波动率≤32% · 回撤≥-8%',
      '因子侧重：波动30% · 质量22% · 流动性16% · 趋势14% · 入场点10% · 板块4% · 筹码4%',
      '组合约束：同方向最多1只(最严控波动,防守观察仓)',
    ].join('\n'),
    maxOutput: 10,
    llmRerank: true,
    portfolioProfile: { maxSameBucket: 1, concentrationPenalty: 3.5 },
  },
];

export function getPreset(id: string): StrategyPreset | undefined {
  return STRATEGY_PRESETS.find((s) => s.id === id);
}
