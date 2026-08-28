/**
 * GET /api/short-term-strategies/stats — 超短线胜率复盘
 * 仅专用口令（tier=advanced）可读；普通口令返回 403。
 */

import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE, getTokenTier } from "@/lib/auth";
import { loadShortTermStats } from "@/services/short-term-strategies/eval";

export async function GET(request: NextRequest) {
  try {
    const tier = await getTokenTier(request.cookies.get(AUTH_COOKIE)?.value);
    if (tier !== "advanced") {
      return NextResponse.json({ error: "无权查看超短线复盘" }, { status: 403 });
    }
    const data = await loadShortTermStats();
    return NextResponse.json(data);
  } catch (e: any) {
    console.error("[api/short-term-strategies/stats]", e);
    return NextResponse.json({ error: e.message || "超短线复盘查询失败" }, { status: 500 });
  }
}