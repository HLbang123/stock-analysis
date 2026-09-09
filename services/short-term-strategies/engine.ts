/**
 * 短线策略 — 纯逻辑扫描引擎（无数据请求，可单测）
 *
 * 把归一化后的 SeriesInput[] 喂给三套既有策略引擎（lib/strategy/*），
 * 输出「最新一根 bar 附近」的可执行候选。所有形态判定复用单一事实源，
 * 不做第二实现。date 统一为 YYYY-MM-DD。
 */

import { detectLimitUpThreeYinAt, ThreeYinBar } from "@/lib/strategy/limit-up-three-yin";
import { detectDragonFirstYinAt } from "@/lib/strategy/dragon-first-yin";
import { detectDoubleDragonBoard } from "@/lib/strategy/double-dragon";
import { detectDragonFourYinAt } from "@/lib/strategy/dragon-four-yin";
import { detectXianRenAt, computeMacdQuadAt } from "@/lib/strategy/xian-ren-zhi-lu";
import { detectLimitUpBoardAt } from "@/lib/strategy/limit-up-board";
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
  const limitPct = /^(300|301|688|689)/.test(series.tsCode) ? 0.20 : 0.10;

  if (strategies.includes("limit-up-three-yin")) {
    const sig = detectLimitUpThreeYinAt(engineBars, lastIdx, { limitPct });
    if (sig.matched) {
      out.push({
        strategy: "limit-up-three-yin",
        tsCode: series.tsCode,
        name: series.name,
        signalType: "limit_up_three_yin",
        matchedDate: lastDate,
        priority: "medium",
        score: 0,
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
    // 只出「今天首阴」，不把昨天触发的首阴翻出来（历史信号归复盘，不混入当日候选）
    const today = detectDragonFirstYinAt(engineBars, lastIdx, { limitPct });
    if (today.matched) {
      out.push(dragonCandidate(series, "firstYinToday", lastDate, today));
    }
  }

  if (strategies.includes("double-dragon")) {
    const board = detectDoubleDragonBoard(engineBars, lastIdx, { limitPct });
    if (board.matched) {
      const ddPriority = board.secondOneWord || board.firstBoardBodyPct >= 5 ? "high" : "medium";
      const prevVol = bars[lastIdx - 1]?.volume ?? 0;
      out.push({
        strategy: "double-dragon",
        tsCode: series.tsCode,
        name: series.name,
        signalType: "double_dragon_board",
        matchedDate: board.entryDate,
        priority: ddPriority,
        score: 0,
        reason: board.reason,
        summary: board.secondOneWord ? "二板一字/秒板，抢筹更强" : "实体首板，二板连续涨停",
        metrics: {
          entryPrice: board.entryPrice,
          board2Date: board.entryDate,
          firstBoardBodyPct: board.firstBoardBodyPct,
          secondOneWord: board.secondOneWord,
          board2VolRatio: prevVol > 0 ? Math.round((bars[lastIdx].volume / prevVol) * 100) / 100 : null,
        },
      });
    }
    // 【2026-09-11 已删除】原「回踩买入」分支（二板后 1~3 日回踩 5 日线且缩量）。
    // 删除依据：十年 6,986 条样本，可实现超额 −0.741pp（t=−9.43）、0/10 年为正、
    // 每笔期望 −1.081%、真实胜率 42.2%。详见 docs/memory/backtest-metric-and-limitup.md。
  }

  if (strategies.includes("dragon-four-yin")) {
    const d4 = detectDragonFourYinAt(engineBars, lastIdx, { limitPct });
    if (d4.matched) {
      out.push({
        strategy: "dragon-four-yin",
        tsCode: series.tsCode,
        name: series.name,
        signalType: "dragon_four_yin",
        matchedDate: d4.entryDate,
        priority: d4.metrics.nearHighPct != null && d4.metrics.nearHighPct >= 100 ? "high" : "medium",
        score: 0,
        reason: d4.reason,
        summary: "涨停首板放量近新高后四连阴，第四阴尾盘关注",
        metrics: {
          boardDate: d4.metrics.boardDate,
          yinBodies: d4.metrics.yinBodies,
          volRatio: d4.metrics.volRatio,
          nearHighPct: d4.metrics.nearHighPct,
          entryPrice: d4.entryPrice,
        },
      });
    }
  }

  if (strategies.includes("xian-ren-zhi-lu")) {
    const xr = detectXianRenAt(engineBars, lastIdx);
    if (xr.matched) {
      // 流通市值（取最近一根有值的 bar；实时合成的今日 bar 无 circMv）→ 打分层小市值加分，不做硬门槛
      let circMvYi: number | null = null;
      for (let k = bars.length - 1; k >= 0; k--) {
        const cv = bars[k].circMv;
        if (cv != null && cv > 0) { circMvYi = Math.round((cv / 10000) * 10) / 10; break; }
      }
      // 试盘日 MACD 象限（单一事实源见 lib/strategy/xian-ren-zhi-lu.ts 的 computeMacdQuadAt）
      // 零轴下方金叉 g1 = 打分层加分项（控制 gain60/试盘日涨幅后仍有增量，详见 docs/xianren-newdim-scan.md）
      const macdQuad = computeMacdQuadAt(engineBars, lastIdx - 1).quad;
      out.push({
        strategy: "xian-ren-zhi-lu",
        tsCode: series.tsCode,
        name: series.name,
        signalType: "xian_ren_zhi_lu",
        matchedDate: xr.entryDate,
        priority: xr.metrics.confPct != null && xr.metrics.confPct >= 100 ? "high" : "medium",
        score: 0,
        reason: xr.reason,
        summary: "试盘长上影后确认日反包，确认日尾盘关注",
        metrics: {
          t0Date: xr.metrics.t0Date,
          upperShadowPct: xr.metrics.upperShadowPct,
          bodyAbsPct: xr.metrics.bodyAbsPct,
          changePct: xr.metrics.changePct,
          volRatio: xr.metrics.volRatio,
          amplitudePct: xr.metrics.amplitudePct,
          gain60: xr.metrics.gain60,
          confPct: xr.metrics.confPct,
          confDayGain: xr.metrics.confDayGain,
          confClosePos: xr.metrics.confClosePos,
          confOpenGap: xr.metrics.confOpenGap,
          confVolRatio: xr.metrics.confVolRatio,
          macdQuad,
          circMvYi,
          entryPrice: xr.entryPrice,
        },
      });
    }
  }

  if (strategies.includes("limit-up-board")) {
    const board = detectLimitUpBoardAt(engineBars, lastIdx, { limitPct });
    if (board.matched) {
      const m = board.metrics;
      out.push({
        strategy: "limit-up-board",
        tsCode: series.tsCode,
        name: series.name,
        signalType: "limit_up_board",
        matchedDate: board.matchedDate,
        // 换手率是「可买性闸门之上期望单调递减」；量比（缩量优先）是十年/五年最强的排序因子
        priority: m.confVolRatio != null && m.confVolRatio < 1.5 ? "high" : "medium",
        score: 0,
        reason: board.reason,
        summary: m.boardCount > 1 ? `${m.boardCount} 连板封板，次日开盘或冲高离场` : "首板封板，次日开盘或冲高离场",
        metrics: {
          limitPrice: m.limitPrice,
          sealPrice: m.sealPrice,
          turnoverRate: m.turnoverRate,
          boardCount: m.boardCount,
          openBoard: m.openBoard,
          amplitudePct: m.amplitudePct,
          confVolRatio: m.confVolRatio,
          confOpenGap: m.confOpenGap,
          macdQuad: m.macdQuad,
          entryPrice: board.entryPrice,
        },
      });
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
    score: 0,
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
