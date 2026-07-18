/**
 * 个股资金流向 — 主力/散户净买入
 * Tushare moneyflow 接口
 */
import { NextRequest, NextResponse } from "next/server";
import { callTushare, toRecords, toTsCode } from "@/lib/tushare";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const days = parseInt(searchParams.get("days") || "5"); // 默认最近 5 个交易日

  if (!code) {
    return NextResponse.json({ error: "缺少股票代码" }, { status: 400 });
  }

  try {
    const tsCode = toTsCode(code);
    const res = await callTushare(
      "moneyflow",
      { ts_code: tsCode, limit: days },
      "ts_code,trade_date,buy_elg_amount,sell_elg_amount,net_mf_amount,buy_lg_amount,sell_lg_amount,net_lg_amount,buy_md_amount,sell_md_amount,net_md_amount,buy_sm_amount,sell_sm_amount,net_sm_amount"
    );
    const records = toRecords(res);

    return NextResponse.json({ success: true, data: records });
  } catch (error: any) {
    console.error("[Tushare moneyflow]", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
