/**
 * 同花顺金融数据 API 客户端
 * 文档：https://fuyao.aicubes.cn/docs
 * 免费接口，key 从 FUYAO_API_KEY 环境变量读取
 */

// tsx 脚本不会自动加载 .env.local，手动加载（与 lib/tushare.ts 同模式）
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE_URL = "https://fuyao.aicubes.cn";

function getKey(): string {
  const key = process.env.FUYAO_API_KEY;
  if (!key) throw new Error("FUYAO_API_KEY 未配置");
  return key;
}

/** 统一请求方法 */
export async function fuyaoGet<T = any>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v) url.searchParams.set(k, v);
    }
  }
  const res = await fetch(url.toString(), {
    headers: { "X-api-key": getKey() },
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json();
  if (json.code !== 0) {
    throw new Error(`同花顺API错误 [${json.code}]: ${json.message}`);
  }
  return json.data as T;
}

// ===== 类型定义 =====

export interface AnomalyItem {
  stock_name: string;
  thscode: string;
  tag_name: string;
  analysis_content: string;
  keyword_list: string[];
}

export interface LimitUpItem {
  thscode: string;
  ticker: string;
  name: string;
  last_price: number;
  price_change_ratio_pct: number;
  limit_up_time: string;
  limit_up_reason: string;
  continue_day_text: string;
  continue_day_cnt: number;
  seal_money: number;
  is_st: boolean;
  is_new: boolean;
}

export interface LimitUpLadderData {
  timestamp: number;
  window: {
    length: number;
    date_list: string[];
    board_caps: Record<string, number>;
  };
  item: Array<{
    date: string;
    boards: Record<string, LimitUpItem[]>;
  }>;
}

export interface HotStockItem {
  thscode: string;
  ticker: string;
  name: string;
  rank: number;
  heat: string;
  rank_change: number;
  rank_trend: string;
}

// ===== API 方法 =====

/** 个股异动原因列表（可选按标签过滤） */
export async function getAnomalyList(tagCodes?: string): Promise<{ timestamp: number; item: AnomalyItem[] }> {
  return fuyaoGet("/api/a-share/special-data/anomaly-analysis-list", tagCodes ? { tag_codes: tagCodes } : undefined);
}

/** 按股票查询异动原因 */
export async function getAnomalyByStock(thscodes: string): Promise<{ timestamp: number; item: AnomalyItem[] }> {
  return fuyaoGet("/api/a-share/special-data/anomaly-analysis-stock", { thscodes });
}

/** 涨停股票池 */
export async function getLimitUpPool(): Promise<{ timestamp: number; item: LimitUpItem[] }> {
  return fuyaoGet("/api/a-share/special-data/limit-up-pool");
}

/** 连板天梯（近30交易日） */
export async function getLimitUpLadder(): Promise<LimitUpLadderData> {
  return fuyaoGet("/api/a-share/special-data/limit-up-ladder");
}

/** 热股榜单 Top30 */
export async function getHotStockList(level: "24h" | "1h" = "24h"): Promise<{ timestamp: number; item: HotStockItem[] }> {
  return fuyaoGet("/api/a-share/special-data/hot-stock-list", { level });
}

/** 飙升榜 Top30（period: day 日榜 / hour 小时榜） */
export async function getSkyrocketList(period: "day" | "hour" = "hour"): Promise<{ timestamp: number; item: HotStockItem[] }> {
  return fuyaoGet("/api/a-share/special-data/skyrocket-list", { period });
}

// ===== 龙虎榜 =====

export interface DragonTigerStockItem {
  thscode: string;
  ticker: string;
  name: string;
  concept_list?: { name: string }[];
  change?: number;                 // 当日涨跌幅(小数, 0.0999≈+10%)
  net_value?: number;              // 龙虎榜净买入(元)
  net_rate?: number;               // 净买入占比(小数)
  hot_rank?: number;               // 同花顺人气排名(越小越靠前)
  buy_value?: number;              // 买方金额(元)
  sell_value?: number;             // 卖方金额(元)
  limit_reason?: string;           // 涨跌停原因
  range_days?: number;             // 1=当日榜 3=3日榜
  org_net_value?: number;          // 机构净买入(元)
  org_net_rate?: number;
  org_buy_num?: number;            // 买入机构数
  org_sell_num?: number;           // 卖出机构数
  amount?: number;                 // 成交金额(元)
  hot_money_net_value?: number;    // 该股游资合计净买入(元)
  hot_money_net_rate?: number;
  hot_money_item_net_value?: number; // 单个游资在该股净买入(元, 游资榜 rows 内)
}

export interface DragonTigerHotMoneyItem {
  name: string;                    // 游资名称(如"成都系")
  buying: number;                  // 聚合净买入(元)
  rows: DragonTigerStockItem[];
}

export interface DragonTigerData {
  timestamp: number;
  board_type: "all" | "org" | "hot_money";
  trade_date: string;
  count: number;
  stock_count: number;
  stock_items: DragonTigerStockItem[];        // all/org 时填充
  hot_money_items: DragonTigerHotMoneyItem[]; // hot_money 时填充
}

/**
 * 龙虎榜榜单（boardType: all 全部 / org 机构榜 / hot_money 游资榜）。
 * date=yyyy-MM-dd，缺省取最近交易日；只支持一年内。实测 2026-08 可用。
 */
export async function getDragonTigerList(
  boardType: "all" | "org" | "hot_money" = "all",
  date?: string
): Promise<DragonTigerData> {
  return fuyaoGet("/api/a-share/special-data/dragon-tiger-list", {
    board_type: boardType,
    ...(date ? { date } : {}),
  });
}

// ===== 历史 K 线（前复权，单票最长10年） =====

export interface FuyaoKBar {
  date_ms: number;   // K线日期(毫秒, Asia/Shanghai 零点)
  open_price: number;
  high_price: number;
  low_price: number;
  close_price: number;
  volume: number;    // 成交量(股)
  turnover: number;  // 成交额(元)
}

/**
 * A 股历史 K 线。单票单次请求，[start,end] 跨度 ≤10 年；adjust: none/forward/backward，默认 forward(前复权)。
 * 与项目 daily_bars(tushare 未复权) 互补：回测/长窗口分析直接用此前复权序列可消除除权假跳空。
 */
export async function getHistoricalK(
  thscode: string,
  startMs: number,
  endMs: number,
  adjust: "none" | "forward" | "backward" = "forward"
): Promise<{ timestamp: number; item: FuyaoKBar[] }> {
  return fuyaoGet("/api/a-share/prices/historical", {
    thscode,
    interval: "1d",
    start: String(startMs),
    end: String(endMs),
    adjust,
  });
}

// ===== 同花顺指数（概念/行业） =====

export interface ThsIndexItem {
  thscode: string;  // 如 886042.TI(概念) / 881101.TI(行业)
  name: string;
}

export type ThsIndexTag = "cn_concept" | "region" | "tszs" | "industry";

/** 同花顺指数清单（按 tag 全量返回，无分页）。cn_concept 概念(约390) / industry 行业(含881一级+884二级) */
export async function getThsIndexList(tag: ThsIndexTag = "cn_concept"): Promise<{ timestamp: number; item: ThsIndexItem[] }> {
  return fuyaoGet("/api/a-share-index/catalog/ths-index-list", { tag });
}

export interface ThsConstituentItem {
  thscode: string;
  ticker: string;
  name: string;
}

/** 指数成分股（单指数，支持 THS 板块 886042.TI 与标准指数 000300.SH） */
export async function getThsConstituents(thscode: string): Promise<{ timestamp: number; item: ThsConstituentItem[] }> {
  return fuyaoGet("/api/a-share-index/constituents/ths-stock-list", { thscode });
}

// ===== 基金数据 =====
export interface FundProfile {
  thscode: string;
  ticker: string;
  fund_name: string;
  estab_date: number;
  mgmt_name: string;
  manager_name: string;
}

export interface FundHolding {
  thscode: string;
  ticker: string;
  stock_name: string;
  hold_ratio: number;
}

/** 基金基本资料 */
export async function getFundProfile(fundType: string, thscode: string): Promise<{ timestamp: number; item: FundProfile[] }> {
  return fuyaoGet("/api/fund/profile/detail", { fund_type: fundType, thscode });
}

/** 基金重仓股 */
export async function getFundHoldings(fundType: string, thscode: string): Promise<{ timestamp: number; item: FundHolding[] }> {
  return fuyaoGet("/api/fund/portfolio/holdings", { fund_type: fundType, thscode });
}
