/**
 * 财务指标 — ROE/ROA/毛利率/净利率/增速
 * Tushare fina_indicator 接口
 */
import { NextRequest, NextResponse } from "next/server";
import { callTushare, toRecords, toTsCode } from "@/lib/tushare";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const limit = parseInt(searchParams.get("limit") || "4"); // 默认最近 4 个季度

  if (!code) {
    return NextResponse.json({ error: "缺少股票代码" }, { status: 400 });
  }

  try {
    const tsCode = toTsCode(code);
    const res = await callTushare(
      "fina_indicator",
      { ts_code: tsCode, limit },
      "ts_code,ann_date,end_date,roe,roe_dt,roa,roa_dt,grossprofit_margin,netprofit_margin,debt_to_assets,or_yoy,profit_dedt,basic_eps_yoy,equity_yoy,op_yoy,ebit_yoy,tr_yoy,current_ratio,quick_ratio,ocf_to_or"
    );
    const records = toRecords(res);

    return NextResponse.json({ success: true, data: records });
  } catch (error: any) {
    console.error("[Tushare fina_indicator]", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
