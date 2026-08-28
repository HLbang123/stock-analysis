/**
 * 短线策略 — 配置与常量
 * 14:30 调度时刻可配置（环境变量 SHORT_TERM_SCAN_TIME，默认 14:30）。
 */

import type { ShortTermStrategyId, ShortTermPhase } from "./types";

export interface StrategyMeta {
  id: ShortTermStrategyId;
  name: string;
  description: string;
}

export const SHORT_TERM_STRATEGIES: StrategyMeta[] = [
  {
    id: "limit-up-three-yin",
    name: "涨停+三连阴",
    description: "涨停后三根小阴线，第三根阴线为尾盘买点",
  },
  {
    id: "dragon-first-yin",
    name: "龙首阴",
    description: "连续涨停后的第一根阴线，3~4 板优先假阴真阳",
  },
  {
    id: "double-dragon",
    name: "双龙战法",
    description: "实体首板突破后连续二板，二板打板或回踩",
  },
];

export const ALL_STRATEGY_IDS: ShortTermStrategyId[] = SHORT_TERM_STRATEGIES.map((s) => s.id);

export const DEFAULT_SCAN_TIME = "14:30";

/** 14:30 调度时刻（环境变量可覆盖，供 crontab/自调度入口使用） */
export function getScanTime(): string {
  return (process.env.SHORT_TERM_SCAN_TIME ?? DEFAULT_SCAN_TIME).trim() || DEFAULT_SCAN_TIME;
}

/** 日线扫描回看窗口（交易日数）：覆盖双龙 60 日突破 + 龙首阴连板 + 量能窗口 */
export const LOOKBACK_TRADING_DAYS = 120;

/** 涨停候选预筛门槛（change_pct ≥ 该值视作涨停候选，引擎内部再精确判定） */
export const LIMIT_UP_CANDIDATE_PCT = 9.5;

export function isStrategyId(v: unknown): v is ShortTermStrategyId {
  return typeof v === "string" && (ALL_STRATEGY_IDS as string[]).includes(v);
}

export function isPhase(v: unknown): v is ShortTermPhase {
  return v === "closing" || v === "morning";
}

export function parseStrategyId(v: unknown): ShortTermStrategyId | null {
  return isStrategyId(v) ? v : null;
}
