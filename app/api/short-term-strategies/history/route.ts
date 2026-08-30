/**
 * GET /api/short-term-strategies/history — 超短线复盘历史明细
 * 按信号日分组，返回每只标的次日（T+1）开盘/最高/最低/收盘四档涨幅。
 * 仅专用口令（tier=advanced）可读。
 */

import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE, getTokenTier } from "@/lib/auth";
import { loadShortTermHistory } from "@/services/short-term-strategies/eval";

export async function GET(request: NextRequest) {
  try {
    const tier = await getTokenTier(request.cookies.get(AUTH_COOKIE)?.value);
    if (tier !== "advanced") {
      return NextResponse.json({ error: "无权查看超短线复盘" }, { status: 403 });
    }
    const data = await loadShortTermHistory();
    return NextResponse.json(data);
  } catch (e: any) {
    console.error("[api/short-term-strategies/history]", e);
    return NextResponse.json({ error: e.message || "超短线复盘明细查询失败" }, { status: 500 });
  }
}
