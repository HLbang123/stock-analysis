/**
 * 短线策略 AI 筛选 — 共享类型
 * 三套策略：涨停+三连阴 / 龙首阴 / 双龙战法。
 * 对外文案禁「股」字，统一用「标的/筛选」。
 */

export type ShortTermStrategyId = "limit-up-three-yin" | "dragon-first-yin" | "double-dragon" | "dragon-four-yin" | "xian-ren-zhi-lu";

/** T 日尾盘落库快照（唯一阶段） */
export type ShortTermPhase = "closing";

export type ShortTermPriority = "high" | "medium" | "low";

/** 归一化日线 bar（引擎纯逻辑输入，date 为 YYYY-MM-DD） */
export interface ShortBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  preClose?: number | null;
  turnoverRate?: number | null;
}

export interface SeriesInput {
  tsCode: string; // 600519.SH
  name: string;
  bars: ShortBar[];
}

export interface ShortTermCandidate {
  strategy: ShortTermStrategyId;
  tsCode: string;
  name: string;
  signalType: string; // firstYinToday / firstYinYesterday / limit_up_three_yin / double_dragon_board / double_dragon_pullback
  matchedDate: string; // YYYY-MM-DD 形态触发日
  priority: ShortTermPriority;
  reason: string;
  summary: string | null;
  metrics: Record<string, unknown>;
}

export interface MarketContext {
  mode: "attack" | "neutral" | "defense";
  tradable: boolean; // false = 退潮期/核按钮环境，默认不输出候选
  limitUpCount: number;
  limitDownCount: number;
  brokenCount: number | null;
  highestBoard: number | null;
  warnings: string[];
}

export interface ShortTermScanResult {
  phase: ShortTermPhase;
  tradeDate: string; // YYYYMMDD 基准交易日（latest daily bar）
  generatedAt: string; // ISO
  market: MarketContext;
  strategies: Record<ShortTermStrategyId, ShortTermCandidate[]>;
}

/** 快照落库行（raw SQL 表 short_term_signals） */
export interface SnapshotRow {
  strategy: ShortTermStrategyId;
  phase: ShortTermPhase;
  tradeDate: string; // YYYYMMDD
  tsCode: string;
  name: string;
  signalType: string;
  matchedDate: string; // YYYY-MM-DD
  priority: ShortTermPriority;
  reason: string;
  summary: string | null;
  metrics: Record<string, unknown>;
  createdAt?: string;
}
