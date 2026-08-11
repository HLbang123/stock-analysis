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

  // 1. 先取 daily_basic，拿到最新交易日（供大盘指数查询用）
  let dailyBasic: Record<string, any>[] = [];
  try {
    const rawDaily = await callTushare(
      "daily_basic",
      { ts_code: tsCode, limit: 5 },
      "ts_code,trade_date,pe,pe_ttm,pb,ps_ttm,total_mv,circ_mv,turnover_rate,volume_ratio"
    );
    dailyBasic = toRecords(rawDaily);
  } catch (e: any) {
    errors.push("daily_basic: " + e.message);
  }
  const latestDate = dailyBasic[0]?.trade_date;

  // 2. 其余并行；大盘指数用 trade_date 一次取回全部指数
  //    （index_dailybasic / index_daily 不支持逗号分隔 ts_code，按 trade_date 查返回当日全部指数）
  //    moneyflow 已改从 stock_moneyflow_ths 表读（同花顺口径），不再实时调接口
  const [finaRes, holderRes, marginRes, hkHoldRes, forecastRes, topListRes, indexBasicRes, indexDailyRes] = await Promise.allSettled([
    callTushare(
      "fina_indicator",
      { ts_code: tsCode, limit: 4 },
      "ts_code,ann_date,end_date,roe,roe_dt,roa,grossprofit_margin,netprofit_margin,debt_to_assets,or_yoy,profit_dedt,basic_eps_yoy,equity_yoy,op_yoy,tr_yoy,current_ratio,quick_ratio,ocf_to_or"
    ),
    callTushare(
      "stk_holdernumber",
      { ts_code: tsCode, limit: 4 },
      "ts_code,ann_date,end_date,holder_num,holder_num_ratio"
    ),
    callTushare(
      "margin_detail",
      { ts_code: tsCode, limit: 5 },
      "ts_code,trade_date,rzye,rqye,rzmre,rzche,rqyl,rqchl,rzrqye"
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
    // 龙虎榜（最近交易日，按个股过滤）
    latestDate
      ? callTushare(
          "top_list",
          { trade_date: latestDate, ts_code: tsCode },
          "trade_date,ts_code,name,close,pct_change,turnover_rate,amount,l_sell,l_buy,l_amount,net_amount,net_rate,amount_rate,reason"
        )
      : Promise.reject(new Error("无最新交易日，跳过龙虎榜")),
    latestDate
      ? callTushare(
          "index_dailybasic",
          { trade_date: latestDate },
          "ts_code,trade_date,pe,pe_ttm,pb,turnover_rate"
        )
      : Promise.reject(new Error("无最新交易日，跳过大盘指数")),
    latestDate
      ? callTushare(
          "index_daily",
          { trade_date: latestDate },
          "ts_code,trade_date,close,pct_chg"
        )
      : Promise.reject(new Error("无最新交易日，跳过大盘指数")),
  ]);

  const finaIndicator =
    finaRes.status === "fulfilled"
      ? toRecords(finaRes.value)
      : (errors.push("fina_indicator: " + finaRes.reason?.message), []);

  // moneyflow：THS 表近 30 日（同花顺口径：净流入万元 + 大中小单占比）
  let moneyflow: any[] = [];
  try {
    const { prisma } = await import("@/lib/db");
    moneyflow = await prisma.stockMoneyflowThs.findMany({
      where: { tsCode },
      orderBy: { tradeDate: "desc" },
      take: 30,
      select: {
        tradeDate: true, netAmount: true, netD5Amount: true,
        buyLgAmount: true, buyLgRate: true, buyMdRate: true, buySmRate: true,
      },
    });
  } catch (e: any) {
    errors.push("moneyflow: " + e.message);
  }

  const holderNumber =
    holderRes.status === "fulfilled"
      ? toRecords(holderRes.value)
      : (errors.push("stk_holdernumber: " + holderRes.reason?.message), []);

  const margin =
    marginRes.status === "fulfilled"
      ? toRecords(marginRes.value)
      : (errors.push("margin_detail: " + marginRes.reason?.message), []);

  const hkHold =
    hkHoldRes.status === "fulfilled"
      ? toRecords(hkHoldRes.value)
      : (errors.push("hk_hold: " + hkHoldRes.reason?.message), []);

  const forecast =
    forecastRes.status === "fulfilled"
      ? toRecords(forecastRes.value)
      : (errors.push("forecast: " + forecastRes.reason?.message), []);

  const topList =
    topListRes.status === "fulfilled"
      ? toRecords(topListRes.value)
      : (errors.push("top_list: " + topListRes.reason?.message), []);

  // 只保留关心的六大指数（trade_date 查询会返回当日全部指数）
  const IDX_CODES = new Set(["000001.SH", "399001.SZ", "399006.SZ", "000016.SH", "000905.SH", "399005.SZ"]);
  const indexDailyBasic =
    indexBasicRes.status === "fulfilled"
      ? toRecords(indexBasicRes.value).filter((r: any) => IDX_CODES.has(r.ts_code))
      : (errors.push("index_dailybasic: " + indexBasicRes.reason?.message), []);
  const indexDaily =
    indexDailyRes.status === "fulfilled"
      ? toRecords(indexDailyRes.value).filter((r: any) => IDX_CODES.has(r.ts_code))
      : (errors.push("index_daily: " + indexDailyRes.reason?.message), []);

  // 合并两份指数数据：ts_code 为 key，index_dailybasic 为主，index_daily 补充 close/pct_chg
  const idxMap = new Map<string, any>();
  for (const item of indexDailyBasic) {
    idxMap.set(item.ts_code, { ...item });
  }
  for (const item of indexDaily) {
    const existing = idxMap.get(item.ts_code);
    idxMap.set(item.ts_code, { ...existing, ...item });
  }
  const indexData = Array.from(idxMap.values());

  // 龙虎榜席位增强（同花顺 fuyao：机构净买入/机构家数/游资净买入，tushare top_list 只有汇总额）。
  // 个股上龙虎榜才有数据，未上榜返回空对象（dragonTiger=null）。
  // 注意：这是可选增强，失败只 console.warn，**不 push errors**——errors 会置 success=false，
  // 而详情页以 `if (d?.success)` 决定是否展示整个基本面段，增强失败不应拖垮主数据。
  let dragonTiger: any = null;
  try {
    const { getDragonTigerList } = await import("@/lib/fuyao");
    const dt = await getDragonTigerList("all");
    const hit = (dt.stock_items || []).filter((s) => s.thscode === tsCode);
    if (hit.length > 0) {
      // 同一只票可能同时有当日榜(range_days=1)和3日榜(range_days=3)，都保留
      dragonTiger = {
        tradeDate: dt.trade_date,
        items: hit.map((s) => ({
          rangeDays: s.range_days,
          netValue: s.net_value,
          netRate: s.net_rate,
          hotRank: s.hot_rank,
          limitReason: s.limit_reason,
          orgNetValue: s.org_net_value,
          orgBuyNum: s.org_buy_num,
          orgSellNum: s.org_sell_num,
          hotMoneyNetValue: s.hot_money_net_value,
          concepts: (s.concept_list || []).map((c) => c.name),
        })),
      };
    }
  } catch (e: any) {
    console.warn("[stock-data] dragonTiger(fuyao) 增强失败（不影响主数据）:", e.message);
  }

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
      topList,
      indexData,
      dragonTiger,
    },
    errors: errors.length > 0 ? errors : undefined,
  });
}
