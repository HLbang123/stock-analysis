/**
 * 每日基本面指标 — PE/PB/市值/换手率
 * Tushare daily_basic 接口
 */
import { NextRequest, NextResponse } from "next/server";
import { callTushare, toRecords, toTsCode } from "@/lib/tushare";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const date = searchParams.get("date"); // YYYYMMDD, 可选，默认最近交易日

  if (!code) {
    return NextResponse.json({ error: "缺少股票代码" }, { status: 400 });
  }

  try {
    const tsCode = toTsCode(code);
    const params: Record<string, any> = { ts_code: tsCode };
    if (date) {
      params.trade_date = date;
    }
    // 默认取最近 5 个交易日
    if (!date) {
      params.limit = 5;
    }

    const res = await callTushare("daily_basic", params, "ts_code,trade_date,pe,pe_ttm,pb,ps,ps_ttm,total_mv,circ_mv,turnover_rate,turnover_rate_f,volume_ratio,dv_ratio,dv_ttm");
    const records = toRecords(res);

    return NextResponse.json({ success: true, data: records });
  } catch (error: any) {
    console.error("[Tushare daily_basic]", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
