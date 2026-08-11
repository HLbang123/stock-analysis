/**
 * AI 筛选 — 策略预设（2026-08-11 因子回测定稿）
 *
 * 基于 2.8 年全市场回测（531+680 交易日，IS/OOS 时序分割，三窗口结论一致）：
 *   - entry_timing +0.07 (t≈15)  唯一强正因子 → 两大策略主力
 *   - risk +0.03~0.08             低波有效，激进池更强
 *   - quality +0.06               强但带未来函数（当前快照），人工保留 0.20~0.25
 *   - trend -0.06 (t≈-12)         反向显著 → 出局（仅留 0.05 防抖动）
 *   - liquidity -0.08             反向 → 出局
 *   - theme_heat ≈0 / chip ≈0     无效 → 出局
 * 硬筛：RPS/量比 原始信号 IC 显著负（热度=均值回归），激进策略加 RPS 上限 + 量比上限；
 *       池子整体超额在长窗口转正（balanced +0.08%），激进池仍负 → 热度过滤必须松。
 * 保留 quality/defensive 两个旧预设（历史胜率数据延续），新 UI 只展示 momentum/balanced。
 */

import type { StrategyPreset } from './types';

export const STRATEGY_PRESETS: StrategyPreset[] = [
  {
    id: 'balanced',
    name: '稳健优选',
    description: '趋势+回踩，基本面加持\n控制波动，相对稳健',
    category: 'balanced',
    hardFilters: {
      excludeSt: true,
      rpsMin: 70,
      rpsPeriod: 60,
      amountMin: 50_000_000, // 5 千万成交额
      priceMin: 3,
      changePctMin: -7,
      changePctMax: 7,
      change60dMax: 60,
      volumeRatioMax: 2.5, // 排除刚爆量（量比 IC -0.11 显著负）
      volatility20dPctMax: 45,
      maxDrawdown20dPctMin: -15,
    },
    factorWeights: {
      entry_timing: 0.50,
      quality: 0.25,
      risk: 0.15,
      trend: 0.05,
      liquidity: 0.03,
      theme_heat: 0.02,
      chip: 0.00,
    },
    scoringProfile: {
      risk_high_volatility_pct: 38.0,
      risk_drawdown_floor_pct: -12.0,
    },
    rankingHints: [
      '优先关注：',
      '1. 入场点在回踩位(距MA20 -5%~0%、RSI 不超买、当日不追涨)',
      '2. 基本面扎实(ROE、毛利率、营收增速靠前)',
      '3. 波动与回撤可控、趋势方向向上但未过热',
      '4. 规避刚放量爆量、单日大涨后的追高',
    ].join('\n'),
    rulesText: [
      '硬筛：RPS(60日)70~95 · 成交额≥5千万 · 单日±7% · 60日涨幅≤60% · 量比≤2.5 · 波动率≤45% · 回撤≥-15%',
      '因子侧重：入场点50% · 质量25% · 波动15% · 趋势5%',
      '组合约束：同方向最多2只',
    ].join('\n'),
    maxOutput: 30,
    llmRerank: true,
    portfolioProfile: { maxSameBucket: 2, concentrationPenalty: 3.5 },
  },
  {
    id: 'momentum',
    name: '趋势猎手',
    description: '强势趋势+低波入场\n波动容忍度更高，追求进攻',
    category: 'momentum',
    hardFilters: {
      excludeSt: true,
      rpsMin: 70,
      rpsMax: 97, // 排除最极端热度区（RPS 分位越高 T+5 越差）
      rpsPeriod: 60,
      amountMin: 80_000_000,
      priceMin: 3,
      changePctMin: -5,
      changePctMax: 7, // 单日 +9.8% 收紧到 +7%，防追高
      change60dMax: 60, // 去掉 60日涨≥5% 下限
      requireMaBullish: true,
      volumeRatioMax: 2.5,
      volatility20dPctMax: 60,
      maxDrawdown20dPctMin: -25,
    },
    factorWeights: {
      entry_timing: 0.35,
      risk: 0.35,
      quality: 0.20,
      trend: 0.05,
      liquidity: 0.03,
      theme_heat: 0.02,
      chip: 0.00,
    },
    scoringProfile: {
      risk_high_volatility_pct: 50.0,
      risk_drawdown_floor_pct: -18.0,
      risk_high_atr_pct: 8.0,
    },
    rankingHints: [
      '优先关注：',
      '1. 强势趋势(MA 多头、MACD 多头)但入场点不追顶(回踩 MA20、RSI 不超买)',
      '2. 波动回撤可控的前提下选趋势最强',
      '3. 基本面健康加分',
      '4. 规避刚放量爆量与单日大涨后的追高',
    ].join('\n'),
    rulesText: [
      '硬筛：RPS(60日)70~97 · 成交额≥8千万 · 单日-5%~+7% · 60日涨幅≤60% · MA5>MA13>MA55 · 量比≤2.5 · 波动率≤60% · 回撤≥-25%',
      '因子侧重：入场点35% · 波动35% · 质量20% · 趋势5%',
      '组合约束：同方向最多2只',
    ].join('\n'),
    maxOutput: 30,
    llmRerank: true,
    portfolioProfile: { maxSameBucket: 2, concentrationPenalty: 4.0 },
  },
  // —— 以下两个旧预设保留（历史胜率数据延续），新 UI 不展示 ——
  {
    id: 'quality',
    name: '高质量',
    description: '优先选公司质地好的票\n等回调到好位置再上车',
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
    maxOutput: 20,
    llmRerank: true,
    portfolioProfile: { maxSameBucket: 2, concentrationPenalty: 3.0 },
  },
  {
    id: 'defensive',
    name: '低波防守',
    description: '涨跌波动小、回撤小，很稳\n适合求稳的防守仓位',
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
    maxOutput: 20,
    llmRerank: true,
    portfolioProfile: { maxSameBucket: 1, concentrationPenalty: 3.5 },
  },
];

export function getPreset(id: string): StrategyPreset | undefined {
  return STRATEGY_PRESETS.find((s) => s.id === id);
}
