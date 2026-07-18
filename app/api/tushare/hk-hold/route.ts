/**
 * 沪深股通持股 — 北向资金持股量和持股比例
 * Tushare hk_hold 接口
 */
import { NextRequest, NextResponse } from "next/server";
import { callTushare, toRecords, toTsCode } from "@/lib/tushare";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const days = parseInt(searchParams.get("days") || "5");

  if (!code) {
    return NextResponse.json({ error: "缺少股票代码" }, { status: 400 });
  }

  try {
    const tsCode = toTsCode(code);
    const res = await callTushare(
      "hk_hold",
      { ts_code: tsCode, limit: days },
      "ts_code,trade_date,hold_vol,hold_ratio"
    );
    const records = toRecords(res);

    return NextResponse.json({ success: true, data: records });
  } catch (error: any) {
    console.error("[Tushare hk_hold]", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
