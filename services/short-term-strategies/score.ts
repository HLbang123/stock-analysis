/**
 * 短线策略 — 百分制强弱打分（0-100，与 AI 筛选打分对齐）
 *
 * 因子来源：
 *   - 形态/筹码因子：candidate.metrics（engine 算好）
 *   - 市场情绪：外部传入 MarketSentiment（scanner 用实时涨停池/连板天梯算）
 *
 * 全部为规则式粗分桶（按 2026-09 训练/验证切分回测定稿），不做连续曲线防过拟合。
 * 龙四阴/板三阴不细化，用 priority 映射兜底，保证五套策略统一 0-100 排序。
 */

import type { ShortTermCandidate } from "./types";

export interface MarketSentiment {
  limitUpCount: number | null; // 实时涨停家数（信号日当天）
  highestBoard: number | null; // 实时最高连板
}

function num(m: Record<string, unknown>, k: string): number | null {
  const v = m[k];
  return typeof v === "number" && Number.isFinite(v) ? (v as number) : null;
}

/** 递增因子分档：tiers 从高到低 [阈值, 分值]，命中第一个 >= 阈值的档。 */
function stepUp(v: number | null, tiers: [number, number][]): number {
  if (v == null) return 0;
  for (const [th, pts] of tiers) if (v >= th) return pts;
  return 0;
}

/** 递减因子分档（越低越好）：tiers 从低到高 [阈值, 分值]，命中第一个 <= 阈值的档。 */
function stepDown(v: number | null, tiers: [number, number][]): number {
  if (v == null) return 0;
  for (const [th, pts] of tiers) if (v <= th) return pts;
  return 0;
}

const PRIORITY_SCORE: Record<string, number> = { high: 80, medium: 55, low: 30 };

export function scoreCandidate(c: ShortTermCandidate, sentiment: MarketSentiment): number {
  const m = c.metrics;
  let s = 0;

  if (c.strategy === "xian-ren-zhi-lu") {
    s += stepUp(num(m, "confPct"), [[185, 20], [140, 14], [100, 8]]);
    s += stepUp(num(m, "confDayGain"), [[4.3, 15], [3, 10], [2, 5]]);
    s += stepDown(num(m, "gain60"), [[-13, 15], [-6, 12], [0, 8]]);
    s += stepUp(sentiment.limitUpCount, [[120, 20], [80, 14], [60, 8]]);
    s += stepUp(sentiment.highestBoard, [[6, 15], [4, 8]]);
    s += stepUp(num(m, "peakPos"), [[0.08, 10], [0.04, 7], [0.001, 4]]);
    s += stepUp(num(m, "upperShadowPct"), [[2.5, 5]]);
  } else if (c.strategy === "double-dragon") {
    if (m["secondOneWord"] === true) s += 60;
    s += stepDown(num(m, "board2VolRatio"), [[0.7, 40], [1, 20]]);
  } else {
    // 龙四阴 / 板三阴：不细化，用 priority 映射
    return PRIORITY_SCORE[c.priority] ?? 50;
  }

  return Math.max(0, Math.min(100, Math.round(s)));
}
