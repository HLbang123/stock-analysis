/**
 * AI 筛选 — 类型定义
 *
 * 设计参考 alphasift (Python) 的 models.py，按本项目可用数据裁剪：
 * 无 PE/PB/市值/换手率，故 Pick 字段相应删减；新增 entryPrice/entryDate 为 T+N 回测埋点。
 * 对外文案一律用「筛选」，避免选股/荐股字眼（合规口径，见 memory/ai-screen-naming-compliance.md）。
 */

/** L1 硬筛配置（驱动 SQL WHERE 子句） */
export interface HardFilterConfig {
  excludeSt?: boolean;
  rpsMin?: number; // RPS 下限
  rpsPeriod?: 20 | 60 | 120 | 250;
  amountMin?: number; // 成交额下限（元，daily_bars.amount 单位千元 → SQL 内换算）
  priceMin?: number;
  priceMax?: number;
  changePctMin?: number;
  changePctMax?: number;
  change60dMin?: number; // 60 日涨幅下限（%）
  change60dMax?: number;
  requireMaBullish?: boolean; // MA5>MA13>MA55 多头排列
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
  description: string;
  category: 'balanced' | 'momentum' | 'quality' | 'defensive';
  hardFilters: HardFilterConfig;
  factorWeights: Record<string, number>; // 归一化前的权重，引擎内归一
  scoringProfile?: Record<string, number>; // 覆盖默认评分曲线参数
  riskProfile?: Record<string, number>;
  portfolioProfile?: PortfolioProfile;
  rankingHints: string; // 给 LLM 的排序提示
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
  signalScore: number | null; // 0-100 综合技术信号

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

  // 入选埋点（T+N 回测用，不可回填，每次必存）
  rank: number;
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
}

/** LLM 重排请求参数（前端传入） */
export interface LlmConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
}
