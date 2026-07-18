/**
 * 融资融券 — 杠杆资金态度
 * Tushare margin 接口
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
      "margin",
      { ts_code: tsCode, limit: days },
      "ts_code,trade_date,rzye,rqye,rzmre,rzche,rqyl,rqchl"
    );
    const records = toRecords(res);

    return NextResponse.json({ success: true, data: records });
  } catch (error: any) {
    console.error("[Tushare margin]", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
