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
    description: "实体首板突破后连续二板，二板打板",
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
  {
    id: "limit-up-board",
    name: "封板",
    description: "当日封于涨停且换手充分，次日开盘或冲高离场",
  },
];

export const ALL_STRATEGY_IDS: ShortTermStrategyId[] = SHORT_TERM_STRATEGIES.map((s) => s.id);

/**
 * 日线扫描回看窗口（交易日数）。
 *
 * 2026-09-10 由 120 收紧到 70：各策略的真实最长历史依赖是
 *   仙人指路 `gain60`：`detectXianRenAt` 要求 `t0Idx >= 60`（T0 往前 60 根）→ 需 ≥61 根 + T1 本身；
 *   新增的 `computeMacdQuadAt`：需 35 根（EMA26 稳定）；
 *   龙四阴：`idx-4-20`（20 日新高）与 `idx-4-10`（10 日均量）→ ~24 根；
 *   双龙：`breakoutLookback: 60` 已随 2026-08-27 定稿删除，检测中不再使用；
 *   龙首阴 / 板三阴：< 15 根。
 * 70 根（含今日实时合成 bar 共 71 根）留 ~9 根余量。
 *
 * 实测（预筛池 1139 只，服务器）：120 日=3350ms/13.7万行 → 70 日=1178ms/8.1万行；
 * 端到端对照 6.3s → 1.6s，且五套策略候选**逐条完全一致**。
 */
export const LOOKBACK_TRADING_DAYS = 70;

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
