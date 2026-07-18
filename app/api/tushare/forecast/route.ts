/**
 * 业绩预告 — 超预期/暴雷预警
 * Tushare forecast 接口
 */
import { NextRequest, NextResponse } from "next/server";
import { callTushare, toRecords, toTsCode } from "@/lib/tushare";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");

  if (!code) {
    return NextResponse.json({ error: "缺少股票代码" }, { status: 400 });
  }

  try {
    const tsCode = toTsCode(code);
    // 取最近一期预告
    const res = await callTushare(
      "forecast",
      { ts_code: tsCode, limit: 1 },
      "ts_code,ann_date,end_date,type,p_change_min,p_change_max,net_profit_min,net_profit_max,last_parent_net,summary,change_reason"
    );
    const records = toRecords(res);

    return NextResponse.json({ success: true, data: records });
  } catch (error: any) {
    console.error("[Tushare forecast]", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
