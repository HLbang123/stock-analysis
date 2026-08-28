/**
 * 短线策略 — 市场环境（退潮期/核按钮把关）+ 连板高度/炸板数 best-effort 拉取
 * 复用 lib/strategy/dragon-first-yin.ts 的 evaluateDragonRegime 单一事实源。
 */

import { evaluateDragonRegime } from "@/lib/strategy/dragon-first-yin";
import type { MarketContext } from "./types";

export function buildMarketContext(
  limitUpCount: number,
  limitDownCount: number,
  brokenCount: number | null,
  highestBoard: number | null
): MarketContext {
  const res = evaluateDragonRegime({
    limitUpCount,
    limitDownCount,
    brokenCount: brokenCount ?? undefined,
    highestBoard: highestBoard ?? 3,
  });
  return {
    mode: res.mode,
    // 退潮期/核按钮环境默认不输出候选（只认 defense；最高板不足只作为 warning 提示）
    tradable: res.mode !== "defense",
    limitUpCount,
    limitDownCount,
    brokenCount,
    highestBoard,
    warnings: res.warnings,
  };
}

export interface MarketExtras {
  highestBoard: number | null;
  brokenCount: number | null;
}

/** 连板高度（fuyao 连板天梯/涨停池）+ 炸板数（tushare limit_list_d Z）——均 best-effort，失败不阻断 */
export async function loadMarketExtras(tradeDate: string): Promise<MarketExtras> {
  let highestBoard: number | null = null;
  let brokenCount: number | null = null;

  try {
    const { getLimitUpLadder, getLimitUpPool } = await import("@/lib/fuyao");
    const ladder = await getLimitUpLadder();
    const caps = Object.keys(ladder?.window?.board_caps ?? {})
      .map((k) => Number(k))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (caps.length) {
      highestBoard = Math.max(...caps);
    } else {
      const pool = await getLimitUpPool();
      const mx = (pool?.item ?? []).reduce((m, r) => Math.max(m, r.continue_day_cnt || 1), 0);
      highestBoard = mx > 0 ? mx : null;
    }
  } catch {
    /* 忽略：连板高度数据不可用 */
  }

  try {
    const { getLimitListD } = await import("@/lib/tushare");
    const rows = await getLimitListD(tradeDate);
    brokenCount = rows.filter((r) => r.limit === "Z").length;
  } catch {
    /* 忽略：炸板数数据不可用 */
  }

  return { highestBoard, brokenCount };
}
