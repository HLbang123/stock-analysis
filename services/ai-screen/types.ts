/**
 * AI 筛选 — 类型定义
 *
 * 设计参考 alphasift (Python) 的 models.py，按本项目可用数据裁剪：
 * 基本面缺 PE/PB/市值，故 Pick 字段相应删减；换手率已纳入 daily_bars 供筹码峰因子使用；新增 entryPrice/entryDate 为 T+N 回测埋点。
 * 对外文案一律用「筛选」，避免选股/荐股字眼（合规口径，见 memory/ai-screen-naming-compliance.md）。
 */

/** L1 硬筛配置（驱动 SQL WHERE 子句） */
export interface HardFilterConfig {
  excludeSt?: boolean;
  rpsMin?: number; // RPS 下限
  rpsMax?: number; // RPS 上限（排除过热区，2026-08-10 因子回测加：RPS 分位越高 T+5 越差）
  rpsPeriod?: 20 | 60 | 120 | 250;
  amountMin?: number; // 成交额下限（元，daily_bars.amount 单位千元 → SQL 内换算）
  priceMin?: number;
  priceMax?: number;
  changePctMin?: number;
  changePctMax?: number;
  change60dMin?: number; // 60 日涨幅下限（%）
  change60dMax?: number;
  requireMaBullish?: boolean; // MA5>MA13>MA55 多头排列
  volumeRatioMax?: number; // 量比上限（排除刚爆量，量比 IC 池内 -0.11 显著负）
  volatility20dPctMax?: number; // 20 日波动率上限
  maxDrawdown20dPctMin?: number; // 20 日最大回撤下限（负值，如 -12 表示不得低于 -12%）
}

/** 风险桶配置（组合分散用） */
export interface PortfolioProfile {
  maxSameBucket?: number; // 同桶最多保留数，默认 1
  concentrationPenalty?: number; // 超配扣分步长，默认 4
  buckets?: Record<string, string[]>; // 桶名 → 关键词列表
}

/** 策略预设（Phase 1 硬编码，后期可改 DB 驱动） */
export interface StrategyPreset {
  id: string;
  name: string;
  description: string; // 完整介绍（折叠区展示）
  category: 'balanced' | 'momentum' | 'quality' | 'defensive';
  hardFilters: HardFilterConfig;
  factorWeights: Record<string, number>; // 归一化前的权重，引擎内归一
  scoringProfile?: Record<string, number>; // 覆盖默认评分曲线参数
  riskProfile?: Record<string, number>;
  portfolioProfile?: PortfolioProfile;
  rankingHints: string; // 给 LLM 的排序提示
  rulesText: string; // 给用户看的规则说明（硬筛 + 因子权重 + 组合约束）
  maxOutput: number;
  llmRerank: boolean; // 是否启用 LLM 重排
}

/** 候选股原始数据（SQL 返回，series 已按日期升序） */
export interface CandidateRaw {
  tsCode: string;
  name: string;
  industry: string | null;
  rps: number | null;
  ret60d: number | null;
  latestClose: number | null;
  latestChange: number | null;
  latestVol: number | null;
  latestAmount: number | null;
  roe: number | null;
  grossprofitMargin: number | null;
  orYoy: number | null;
  industryChangePct: number | null;
  closes: number[];
  highs: number[];
  lows: number[];
  vols: number[];
  turnoverRates: (number | null)[]; // 换手率序列（%），筹码峰因子用，NULL 触发固定衰减降级
}

/** 候选 + 计算特征 + 打分 + LLM 重排 + 风险层后的最终对象 */
export interface AiPick {
  tsCode: string;
  name: string;
  industry: string | null;

  // 原始快照
  rps: number | null;
  latestClose: number | null;
  latestChange: number | null;
  latestAmount: number | null;

  // 技术特征（TS 侧计算）
  ret60d: number | null;
  macdStatus: string; // bullish / bearish / neutral
  rsiStatus: string; // oversold / overbought / neutral
  volatility20d: number | null;
  maxDrawdown20d: number | null;
  atr20: number | null;
  volumeRatio: number | null;
  signalScore: number | null; // 0-100 综合技术信号(仅供 risk.ts 风险层读取,不再喂因子)
  maBullish: boolean | null; // MA5>MA13>MA55 多头排列(trend 因子独占)
  pullbackToMa20Pct: number | null; // (latestClose−MA20)/MA20×100,回踩深度(entry_timing 用)
  breakout20dPct: number | null; // (latestClose−20日最高)/20日最高×100,shape_status 用

  // 筹码峰特征（lib/chip.ts 单一事实源）
  chipConcentration: number | null; // 90% 集中度，越小越密集
  chipProfitRatio: number | null;   // 获利盘比例 0-1
  chipPeakPos: number | null;       // (价 − 主峰) / avgCost，站上主峰为正
  chipPeakDrift: number | null;     // 5 日峰位漂移 / avgCost，下移为负(吸筹)

  // 箱体形态特征（lib/box.ts，2026-08-14 移植；运行态字段，不落库单列——
  // 质量分以 factorScores.box 零权重观察因子身份随 JSON 落库攒样本，IC 验证有效后再升正式因子）
  boxQuality: number | null; // 0-100 箱体质量分（null=非箱体或数据不足）
  boxPos: number | null;     // 现价在箱体内位置 (价−底)/箱高：<0 跌破、>1 突破

  // 基本面
  roe: number | null;
  grossprofitMargin: number | null;
  orYoy: number | null;
  industryChangePct: number | null;

  // 因子分 + 规则总分
  factorScores: Record<string, number>;
  screenScore: number;

  // LLM 重排输出
  llmScore: number | null;
  llmConfidence: number | null;
  llmSector: string;
  llmTheme: string;
  llmThesis: string;
  rankingReason: string;
  riskSummary: string;
  llmCatalysts: string[];
  llmRisks: string[];
  llmTags: string[];
  llmStyleFit: string;
  llmWatchItems: string[];
  llmInvalidators: string[];

  // 风险层 + 组合层后的最终分
  finalScore: number;
  riskScore: number | null;
  riskLevel: string; // low / medium / high
  riskPenalty: number;
  riskFlags: string[];
  portfolioPenalty: number;

  // 入选埋点(T+N 回测用,不可回填,每次必存)
  selected: boolean; // true=最终入选 top-N;false=候选池未入选
  rank: number; // 入选名次 1..N;未入选为 0(落库时映射 null)
  entryPrice: number | null; // 运行时的 latestClose
  entryDate: string; // 运行时的 barDate
}

/** 一次筛选运行 */
export interface AiScreenRun {
  id: string;
  strategyId: string;
  strategyName: string;
  createdAt: string; // ISO
  barDate: string;
  rpsPeriod: number;
  candidateCount: number;
  pickCount: number;
  llmReranked: boolean;
  llmModel: string | null;
  llmMarketView: string;
  llmSelectionLogic: string;
  llmPortfolioRisk: string;
  llmCoverage: number | null;
  degradation: string[];
  riskEnabled: boolean;
  portfolioEnabled: boolean;
  marketRegime: string | null; // attack / neutral / defense（2026-08-14 市场状态标记，只展示不拦截）
}

/** LLM 重排请求参数（前端传入） */
export interface LlmConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
}
