/**
 * 聚合接口：一次性获取 AI 分析所需的所有 Tushare 数据
 * GET /api/tushare/stock-data?code=000001
 */
import { NextRequest, NextResponse } from "next/server";
import { callTushare, toRecords, toTsCode } from "@/lib/tushare";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");

  if (!code) {
    return NextResponse.json({ error: "缺少股票代码" }, { status: 400 });
  }

  const tsCode = toTsCode(code);
  const errors: string[] = [];

  // 并行获取三项数据
  const [dailyBasicRes, finaRes, moneyflowRes] = await Promise.allSettled([
    callTushare(
      "daily_basic",
      { ts_code: tsCode, limit: 5 },
      "ts_code,trade_date,pe,pe_ttm,pb,ps_ttm,total_mv,circ_mv,turnover_rate,volume_ratio"
    ),
    callTushare(
      "fina_indicator",
      { ts_code: tsCode, limit: 4 },
      "ts_code,ann_date,end_date,roe,roe_dt,roa,grossprofit_margin,netprofit_margin,debt_to_assets,or_yoy,profit_dedt,basic_eps_yoy,equity_yoy,op_yoy,tr_yoy,current_ratio,quick_ratio,ocf_to_or"
    ),
    callTushare(
      "moneyflow",
      { ts_code: tsCode, limit: 5 },
      "ts_code,trade_date,buy_elg_amount,sell_elg_amount,net_mf_amount,buy_lg_amount,sell_lg_amount,net_lg_amount,buy_md_amount,sell_md_amount,net_md_amount,buy_sm_amount,sell_sm_amount,net_sm_amount"
    ),
  ]);

  const dailyBasic =
    dailyBasicRes.status === "fulfilled"
      ? toRecords(dailyBasicRes.value)
      : (errors.push("daily_basic: " + dailyBasicRes.reason?.message), []);

  const finaIndicator =
    finaRes.status === "fulfilled"
      ? toRecords(finaRes.value)
      : (errors.push("fina_indicator: " + finaRes.reason?.message), []);

  const moneyflow =
    moneyflowRes.status === "fulfilled"
      ? toRecords(moneyflowRes.value)
      : (errors.push("moneyflow: " + moneyflowRes.reason?.message), []);

  return NextResponse.json({
    success: errors.length === 0,
    data: {
      dailyBasic,
      finaIndicator,
      moneyflow,
    },
    errors: errors.length > 0 ? errors : undefined,
  });
}
