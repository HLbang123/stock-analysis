/**
 * 短线策略 — 配置与常量
 */

import type { ShortTermStrategyId } from "./types";

export interface StrategyMeta {
  id: ShortTermStrategyId;
  name: string;
  description: string;
}

export const SHORT_TERM_STRATEGIES: StrategyMeta[] = [
  {
    id: "limit-up-three-yin",
    name: "板三阴",
    description: "涨停后三根小阴线，第三根阴线为尾盘买点",
  },
  {
    id: "dragon-first-yin",
    name: "龙首阴",
    description: "连续涨停后的第一根阴线，3~4 板优先假阴真阳",
  },
  {
    id: "double-dragon",
    name: "双龙",
    description: "实体首板突破后连续二板，二板打板或回踩",
  },
  {
    id: "dragon-four-yin",
    name: "龙四阴",
    description: "涨停首板放量近新高后四连阴，第四阴尾盘关注",
  },
  {
    id: "xian-ren-zhi-lu",
    name: "仙人指路",
    description: "试盘长上影后确认日反包，确认日尾盘关注",
  },
];

export const ALL_STRATEGY_IDS: ShortTermStrategyId[] = SHORT_TERM_STRATEGIES.map((s) => s.id);

/** 日线扫描回看窗口（交易日数）：覆盖双龙 60 日突破 + 龙首阴连板 + 量能窗口 */
export const LOOKBACK_TRADING_DAYS = 120;

/** 前置筛选窗口（交易日数）：覆盖各策略最小触发窗口 + 盘中实时 bar 错位缓冲 */
export const PREFILTER_TRADING_DAYS = 20;

/** 涨停候选预筛门槛（change_pct ≥ 该值视作涨停候选，引擎内部再精确判定） */
export const LIMIT_UP_CANDIDATE_PCT = 9.5;

export function isStrategyId(v: unknown): v is ShortTermStrategyId {
  return typeof v === "string" && (ALL_STRATEGY_IDS as string[]).includes(v);
}

export function parseStrategyId(v: unknown): ShortTermStrategyId | null {
  return isStrategyId(v) ? v : null;
}
