/**
 * 短线策略扫描编排烟雾测试（纯逻辑，无 DB/网络）
 *
 * 验证：
 *  1. 扫描引擎能产出板三阴 / 龙首阴 / 双龙候选；
 *  2. 退潮期把关（跌停家数多 → 不输出）。
 *
 * 用法：npx tsx scripts/test-short-term-scan.ts
 */

import { buildAllCandidates } from "../services/short-term-strategies/engine";
import { buildMarketContext } from "../services/short-term-strategies/market";
import { ALL_STRATEGY_IDS } from "../services/short-term-strategies/config";
import type { SeriesInput, ShortBar, ShortTermCandidate } from "../services/short-term-strategies/types";

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  console.log("PASS:", msg);
}

function isoDay(offset: number): string {
  return new Date(Date.UTC(2026, 5, 1 + offset)).toISOString().slice(0, 10);
}

function count(candidates: ShortTermCandidate[], strategy: string, signalType: string): number {
  return candidates.filter((c) => c.strategy === strategy && c.signalType === signalType).length;
}

// ── 1. 涨停+三连阴（最后一根 = 第三阴）──
const threeYinSeries: SeriesInput = {
  tsCode: "600000.SH",
  name: "测试主板标的",
  bars: [
    { date: isoDay(0), open: 10.50, high: 11.00, low: 10.40, close: 11.00, volume: 1000000, preClose: 10.00 },
    { date: isoDay(1), open: 11.20, high: 11.30, low: 10.80, close: 10.95, volume: 800000, preClose: 11.00 },
    { date: isoDay(2), open: 10.96, high: 11.00, low: 10.70, close: 10.80, volume: 600000, preClose: 10.95 },
    { date: isoDay(3), open: 10.81, high: 10.85, low: 10.65, close: 10.70, volume: 400000, preClose: 10.80 },
  ],
};

// ── 2. 龙首阴（最后一根 = 首阴）──
const dragonSeries: SeriesInput = {
  tsCode: "000001.SZ",
  name: "测试主板标的",
  bars: [
    { date: isoDay(0), open: 10.50, high: 11.00, low: 10.40, close: 11.00, volume: 1000000, preClose: 10.00, turnoverRate: 10 },
    { date: isoDay(1), open: 11.50, high: 12.10, low: 11.40, close: 12.10, volume: 1000000, preClose: 11.00, turnoverRate: 10 },
    { date: isoDay(2), open: 12.60, high: 13.31, low: 12.50, close: 13.31, volume: 1000000, preClose: 12.10, turnoverRate: 10 },
    { date: isoDay(3), open: 13.50, high: 13.60, low: 13.10, close: 13.20, volume: 900000, preClose: 13.31, turnoverRate: 20 },
  ],
};

// ── 3. 双龙打板（最后一根 = 二板）──
const ddBase: ShortBar[] = Array.from({ length: 60 }, (_, i) => ({
  date: isoDay(-70 + i),
  open: 10.0,
  high: 10.1,
  low: 9.9,
  close: 10.0,
  volume: 50000,
}));
const ddBoardSeries: SeriesInput = {
  tsCode: "002001.SZ",
  name: "测试主板标的",
  bars: [
    ...ddBase,
    { date: isoDay(-9), open: 10.20, high: 11.00, low: 10.10, close: 11.00, volume: 100000, preClose: 10.00 },
    { date: isoDay(-8), open: 11.20, high: 12.10, low: 11.10, close: 12.10, volume: 120000, preClose: 11.00 },
  ],
};

// 全量扫描三套策略
const all = buildAllCandidates([threeYinSeries, dragonSeries, ddBoardSeries], ALL_STRATEGY_IDS);
assert(count(all, "limit-up-three-yin", "limit_up_three_yin") === 1, "涨停+三连阴产出候选");
assert(count(all, "dragon-first-yin", "firstYinToday") === 1, "龙首阴产出候选(firstYinToday)");
assert(count(all, "double-dragon", "double_dragon_board") === 1, "双龙战法产出候选(二板打板)");

// ── 4. 退潮期把关 ──
const defense = buildMarketContext(30, 15, 5, 4);
assert(defense.mode === "defense" && defense.tradable === false, "跌停家数多应判定退潮期且不可交易");
const attack = buildMarketContext(80, 2, 5, 6);
assert(attack.mode === "attack" && attack.tradable === true, "涨停多跌停少应判定进攻期且可交易");

console.log("ALL SHORT-TERM SCAN TESTS PASSED");
