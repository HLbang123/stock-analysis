/**
 * 股东人数 — 筹码集中度趋势
 * Tushare stk_holdernumber 接口
 */
import { NextRequest, NextResponse } from "next/server";
import { callTushare, toRecords, toTsCode } from "@/lib/tushare";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const limit = parseInt(searchParams.get("limit") || "4");

  if (!code) {
    return NextResponse.json({ error: "缺少股票代码" }, { status: 400 });
  }

  try {
    const tsCode = toTsCode(code);
    const res = await callTushare(
      "stk_holdernumber",
      { ts_code: tsCode, limit },
      "ts_code,ann_date,end_date,holder_num,holder_num_ratio"
    );
    const records = toRecords(res);

    return NextResponse.json({ success: true, data: records });
  } catch (error: any) {
    console.error("[Tushare stk_holdernumber]", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
