/**
 * 短线策略 — 纯逻辑扫描引擎（无数据请求，可单测）
 *
 * 把归一化后的 SeriesInput[] 喂给三套既有策略引擎（lib/strategy/*），
 * 输出「最新一根 bar 附近」的可执行候选。所有形态判定复用单一事实源，
 * 不做第二实现。date 统一为 YYYY-MM-DD。
 */

import { detectLimitUpThreeYinAt, ThreeYinBar } from "@/lib/strategy/limit-up-three-yin";
import { detectDragonFirstYinAt } from "@/lib/strategy/dragon-first-yin";
import { detectDoubleDragonBoard, detectDoubleDragonPullback } from "@/lib/strategy/double-dragon";
import type { SeriesInput, ShortBar, ShortTermCandidate, ShortTermStrategyId } from "./types";

function toEngineBars(bars: ShortBar[]): ThreeYinBar[] {
  // 三套引擎的 bar 结构一致，统一映射一次
  return bars.map((b) => ({
    date: b.date,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
    preClose: b.preClose ?? null,
    turnoverRate: b.turnoverRate ?? null,
  }));
}

/**
 * 对单支标的、按指定策略集产出「最新」候选。
 * 语义：T 日尾盘视角 —— 信号发生在最后一根 bar 上（或龙首阴允许发生在倒数第二根 = firstYinYesterday）。
 */
export function buildCandidatesForSeries(
  series: SeriesInput,
  strategies: ShortTermStrategyId[]
): ShortTermCandidate[] {
  const bars = series.bars;
  const out: ShortTermCandidate[] = [];
  if (bars.length < 2) return out;

  const engineBars = toEngineBars(bars);
  const lastIdx = bars.length - 1;
  const lastDate = bars[lastIdx].date;

  if (strategies.includes("limit-up-three-yin")) {
    const sig = detectLimitUpThreeYinAt(engineBars, lastIdx);
    if (sig.matched) {
      out.push({
        strategy: "limit-up-three-yin",
        tsCode: series.tsCode,
        name: series.name,
        signalType: "limit_up_three_yin",
        matchedDate: lastDate,
        priority: "medium",
        reason: sig.reason,
        summary: "涨停后三连阴，第三根阴线为尾盘买点",
        metrics: {
          limitPrice: sig.metrics.limitPrice,
          yinBodies: sig.metrics.yinBodies,
          volumes: sig.metrics.volumes,
          entryClose: sig.metrics.entryClose,
        },
      });
    }
  }

  if (strategies.includes("dragon-first-yin")) {
    const today = detectDragonFirstYinAt(engineBars, lastIdx);
    if (today.matched) {
      out.push(dragonCandidate(series, "firstYinToday", lastDate, today));
    } else if (lastIdx >= 1) {
      const yesterday = detectDragonFirstYinAt(engineBars, lastIdx - 1);
      if (yesterday.matched) {
        out.push(dragonCandidate(series, "firstYinYesterday", bars[lastIdx - 1].date, yesterday));
      }
    }
  }

  if (strategies.includes("double-dragon")) {
    const board = detectDoubleDragonBoard(engineBars, lastIdx);
    if (board.matched) {
      const ddPriority = board.secondOneWord || board.firstBoardBodyPct >= 5 ? "high" : "medium";
      out.push({
        strategy: "double-dragon",
        tsCode: series.tsCode,
        name: series.name,
        signalType: "double_dragon_board",
        matchedDate: board.entryDate,
        priority: ddPriority,
        reason: board.reason,
        summary: board.secondOneWord ? "二板一字/秒板，抢筹更强" : "实体首板，二板连续涨停",
        metrics: {
          entryType: board.entryType,
          entryPrice: board.entryPrice,
          board2Date: board.entryDate,
          firstBoardBodyPct: board.firstBoardBodyPct,
          secondOneWord: board.secondOneWord,
          caveat: "二板打板为日线基线口径，未过滤二板一字板可成交（封板先后在 T+1 早盘实时过滤）",
        },
      });
    }
    // 回踩买入：二板后的 1~3 个交易日内回踩到 5 日线附近；今日为回踩日
    for (const b2 of [lastIdx - 1, lastIdx - 2]) {
      if (b2 < 1) continue;
      const pb = detectDoubleDragonPullback(engineBars, b2);
      if (pb.matched && pb.entryDate === lastDate) {
        out.push({
          strategy: "double-dragon",
          tsCode: series.tsCode,
          name: series.name,
          signalType: "double_dragon_pullback",
          matchedDate: pb.entryDate,
          priority: "medium",
          reason: pb.reason,
          summary: "二板后回踩 5 日线且缩量",
          metrics: { entryType: pb.entryType, entryPrice: pb.entryPrice, board2Date: pb.entryDate },
        });
      }
    }
  }

  return out;
}

function dragonCandidate(
  series: SeriesInput,
  signalType: "firstYinToday" | "firstYinYesterday",
  matchedDate: string,
  sig: ReturnType<typeof detectDragonFirstYinAt>
): ShortTermCandidate {
  return {
    strategy: "dragon-first-yin",
    tsCode: series.tsCode,
    name: series.name,
    signalType,
    matchedDate,
    priority: sig.priority,
    reason: sig.reason,
    summary: sig.summary ?? null,
    metrics: {
      boardCount: sig.run?.boardCount ?? null,
      yinType: sig.yin?.fakeYin ? "假阴真阳" : sig.yin?.realYin ? "真阴" : null,
      volumeRatio: sig.yin?.volumeRatio ?? null,
      turnoverRate: sig.yin?.turnoverRate ?? null,
      bodyPct: sig.yin?.bodyPct ?? null,
      quality: sig.run?.quality ?? null,
    },
  };
}

export function buildAllCandidates(
  allSeries: SeriesInput[],
  strategies: ShortTermStrategyId[]
): ShortTermCandidate[] {
  const out: ShortTermCandidate[] = [];
  for (const series of allSeries) {
    out.push(...buildCandidatesForSeries(series, strategies));
  }
  return out;
}
