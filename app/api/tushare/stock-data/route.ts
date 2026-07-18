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

  // 并行获取七项数据
  const [dailyBasicRes, finaRes, moneyflowRes, holderRes, marginRes, hkHoldRes, forecastRes] = await Promise.allSettled([
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
    callTushare(
      "stk_holdernumber",
      { ts_code: tsCode, limit: 4 },
      "ts_code,ann_date,end_date,holder_num,holder_num_ratio"
    ),
    callTushare(
      "margin",
      { ts_code: tsCode, limit: 5 },
      "ts_code,trade_date,rzye,rqye,rzmre,rzche,rqyl,rqchl"
    ),
    callTushare(
      "hk_hold",
      { ts_code: tsCode, limit: 5 },
      "ts_code,trade_date,hold_vol,hold_ratio"
    ),
    callTushare(
      "forecast",
      { ts_code: tsCode, limit: 1 },
      "ts_code,ann_date,end_date,type,p_change_min,p_change_max,net_profit_min,net_profit_max,last_parent_net,summary,change_reason"
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

  const holderNumber =
    holderRes.status === "fulfilled"
      ? toRecords(holderRes.value)
      : (errors.push("stk_holdernumber: " + holderRes.reason?.message), []);

  const margin =
    marginRes.status === "fulfilled"
      ? toRecords(marginRes.value)
      : (errors.push("margin: " + marginRes.reason?.message), []);

  const hkHold =
    hkHoldRes.status === "fulfilled"
      ? toRecords(hkHoldRes.value)
      : (errors.push("hk_hold: " + hkHoldRes.reason?.message), []);

  const forecast =
    forecastRes.status === "fulfilled"
      ? toRecords(forecastRes.value)
      : (errors.push("forecast: " + forecastRes.reason?.message), []);

  return NextResponse.json({
    success: errors.length === 0,
    data: {
      dailyBasic,
      finaIndicator,
      moneyflow,
      holderNumber,
      margin,
      hkHold,
      forecast,
    },
    errors: errors.length > 0 ? errors : undefined,
  });
}
