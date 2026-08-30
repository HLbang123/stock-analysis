/**
 * GET  /api/short-term-strategies — 读取落库快照（候选列表）
 * POST /api/short-term-strategies — 触发全量扫描
 *   body: { strategy?, persist? = false, tradeDate? }
 *   persist=false：仅返回扫描结果展示，不落库（手动扫描）
 *   persist=true：落库当日快照（尾盘自动任务专用）
 *
 * 权限：仅专用口令（tier=advanced）可读/可触发；普通口令返回空快照。
 * 对外文案禁「股」字（用「标的/筛选」），不输出买卖建议措辞。
 */

import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE, getTokenTier } from "@/lib/auth";
import {
  SHORT_TERM_STRATEGIES,
  parseStrategyId,
} from "@/services/short-term-strategies/config";
import {
  runClosingScan,
  loadSnapshotResult,
} from "@/services/short-term-strategies/scanner";

const EMPTY_CANDIDATES = {
  "limit-up-three-yin": [],
  "dragon-first-yin": [],
  "double-dragon": [],
  "dragon-four-yin": [],
  "xian-ren-zhi-lu": [],
};

async function isAdvanced(request: NextRequest): Promise<boolean> {
  const tier = await getTokenTier(request.cookies.get(AUTH_COOKIE)?.value);
  return tier === "advanced";
}

export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const strategy = parseStrategyId(sp.get("strategy"));
    const tradeDate = sp.get("tradeDate") || undefined;

    if (!(await isAdvanced(request))) {
      return NextResponse.json({
        strategies: [],
        phase: "closing",
        tradeDate: tradeDate ?? "",
        generated: false,
        generatedAt: null,
        market: null,
        candidates: EMPTY_CANDIDATES,
      });
    }

    const result = await loadSnapshotResult({ strategy: strategy ?? undefined, tradeDate });
    return NextResponse.json({
      strategies: SHORT_TERM_STRATEGIES,
      phase: result.phase,
      tradeDate: result.tradeDate,
      generated: result.generated,
      generatedAt: result.generatedAt,
      market: result.market,
      candidates: result.strategies,
    });
  } catch (e: any) {
    console.error("[api/short-term-strategies GET]", e);
    return NextResponse.json({ error: e.message || "查询短线候选失败" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    if (!(await isAdvanced(request))) {
      return NextResponse.json({ error: "无权触发超短线扫描" }, { status: 403 });
    }

    const body = (await request.json().catch(() => ({}))) as {
      strategy?: string;
      persist?: boolean;
      tradeDate?: string;
    };
    const strategy = parseStrategyId(body.strategy);
    const strategies = strategy ? [strategy] : undefined;
    const tradeDate = body.tradeDate || undefined;

    const result = await runClosingScan({ strategies, tradeDate, persist: body.persist === true });

    return NextResponse.json({
      strategies: SHORT_TERM_STRATEGIES,
      phase: result.phase,
      tradeDate: result.tradeDate,
      generatedAt: result.generatedAt,
      market: result.market,
      candidates: result.strategies,
    });
  } catch (e: any) {
    console.error("[api/short-term-strategies POST]", e);
    return NextResponse.json({ error: e.message || "短线扫描失败" }, { status: 500 });
  }
}