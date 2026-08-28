/**
 * 短线策略 — T+1 早盘实时过滤（复用快照，不重扫全市场）
 *
 * 可落地硬条件：双龙「二板封板时间早于首板封板时间」（evaluateDoubleDragon）。
 * 龙首阴 9:25 集合竞价涨停、涨停+三连阴尾盘 5 分钟横盘，属盘口硬条件，
 * 需分钟级数据源，此处不做二次实现，仅在返回中保留候选并标注 realtime 状态。
 */

import { evaluateDoubleDragon, BoardSealInfo } from "@/lib/strategy/dragon-first-yin";
import type { ShortTermCandidate } from "./types";

export interface RealtimeFilterContext {
  /** code → 今日（二板）封板时间 + 是否一字板 + 连板高度 */
  todayLimitUp: Map<string, { firstTime: string; isOneWord: boolean; continueDayCnt: number | null }>;
  /** code → 昨日（首板）封板时间 */
  yesterdayFirstBoard: Map<string, string>;
}

export function applyRealtimeFilters(
  candidates: ShortTermCandidate[],
  ctx: RealtimeFilterContext | null
): ShortTermCandidate[] {
  const out: ShortTermCandidate[] = [];
  for (const c of candidates) {
    if (c.strategy !== "double-dragon" || c.signalType !== "double_dragon_board") {
      out.push(c);
      continue;
    }
    if (!ctx) {
      out.push({ ...c, metrics: { ...c.metrics, realtime: "unavailable" } });
      continue;
    }
    const today = ctx.todayLimitUp.get(c.tsCode);
    const yday = ctx.yesterdayFirstBoard.get(c.tsCode);
    if (!today || !yday) {
      out.push({ ...c, metrics: { ...c.metrics, realtime: "unavailable" } });
      continue;
    }
    if (today.continueDayCnt != null && today.continueDayCnt !== 2) {
      // 连板高度异常时不再直接剔除，交给日线「恰好二板」硬过滤；这里只标记
      out.push({ ...c, metrics: { ...c.metrics, realtime: "height_mismatch", height: today.continueDayCnt } });
      continue;
    }
    const first: BoardSealInfo = { boardNumber: 1, firstLimitTime: yday, isOneWord: false };
    const second: BoardSealInfo = { boardNumber: 2, firstLimitTime: today.firstTime, isOneWord: today.isOneWord };
    const res = evaluateDoubleDragon(first, second);
    out.push({
      ...c,
      metrics: {
        ...c.metrics,
        realtime: res.secondEarlier ? "passed" : "seal_failed",
        sealScore: res.score,
      },
    });
  }
  return out;
}

/** 拉取实时过滤上下文（best-effort，失败返回空上下文=不做剔除） */
export async function loadRealtimeContext(yesterdayTradeDate: string): Promise<RealtimeFilterContext> {
  const todayLimitUp = new Map<string, { firstTime: string; isOneWord: boolean; continueDayCnt: number | null }>();
  const yesterdayFirstBoard = new Map<string, string>();

  try {
    const { getLimitUpPool, normalizeThscode } = await import("@/lib/fuyao");
    const pool = await getLimitUpPool();
    for (const r of pool?.item ?? []) {
      const code = normalizeThscode(r.thscode);
      if (!code) continue;
      todayLimitUp.set(code, { firstTime: r.limit_up_time ?? "", isOneWord: false, continueDayCnt: r.continue_day_cnt ?? null });
    }
  } catch {
    /* 忽略 */
  }

  try {
    const { getLimitListD } = await import("@/lib/tushare");
    const rows = await getLimitListD(yesterdayTradeDate, "U");
    for (const r of rows) {
      if (r.ts_code && r.first_time) {
        yesterdayFirstBoard.set(String(r.ts_code), String(r.first_time));
      }
    }
  } catch {
    /* 忽略 */
  }

  return { todayLimitUp, yesterdayFirstBoard };
}
