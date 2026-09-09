/**
 * 短线策略 — 市场环境（退潮期/核按钮把关）+ 连板高度/炸板数 best-effort 拉取
 * 复用 lib/strategy/dragon-first-yin.ts 的 evaluateDragonRegime 单一事实源。
 */

import { evaluateDragonRegime } from "@/lib/strategy/dragon-first-yin";
import type { MarketContext } from "./types";

/** 给 best-effort 外部调用加硬超时（Tushare 单次最坏 87s，会拖垮手动扫描） */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`external timeout ${ms}ms`)), ms)),
  ]);
}

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
  /** 外部数据不可用的告警（2026-09-10 起不再静默吞掉，交回调用方显式降级/展示） */
  warnings: string[];
}

/**
 * 连板高度（fuyao 连板天梯/涨停池）+ 炸板数（tushare limit_list_d Z）——均 best-effort，失败不阻断。
 *
 * 2026-09-10：超时由 12s 收紧到 3s（原来两个 fuyao 调用最坏各等 12s，一次扫描白等最多 24s），
 * 并把失败记录进 warnings 由调用方降级到「本地实时行情推算」，不再静默。
 */
export async function loadMarketExtras(tradeDate: string): Promise<MarketExtras> {
  let highestBoard: number | null = null;
  let brokenCount: number | null = null;
  const warnings: string[] = [];

  try {
    const { getLimitUpLadder, getLimitUpPool } = await import("@/lib/fuyao");
    const ladder = await withTimeout(getLimitUpLadder(), 3000);
    const caps = Object.keys(ladder?.window?.board_caps ?? {})
      .map((k) => Number(k))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (caps.length) {
      highestBoard = Math.max(...caps);
    } else {
      const pool = await withTimeout(getLimitUpPool(), 3000);
      const mx = (pool?.item ?? []).reduce((m, r) => Math.max(m, r.continue_day_cnt || 1), 0);
      highestBoard = mx > 0 ? mx : null;
    }
  } catch (e: any) {
    warnings.push(`连板高度外部数据不可用（${e?.message ?? "unknown"}）`);
  }

  try {
    const { getLimitListD } = await import("@/lib/tushare");
    const rows = await withTimeout(getLimitListD(tradeDate), 3000);
    brokenCount = rows.filter((r) => r.limit === "Z").length;
  } catch (e: any) {
    warnings.push(`炸板数外部数据不可用（${e?.message ?? "unknown"}）`);
  }

  return { highestBoard, brokenCount, warnings };
}
