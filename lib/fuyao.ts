/**
 * 同花顺金融数据 API 客户端
 * 文档：https://fuyao.aicubes.cn/docs
 * 免费接口，key 从 FUYAO_API_KEY 环境变量读取
 */

// tsx 脚本不会自动加载 .env.local，手动加载（与 lib/tushare.ts 同模式）
import dotenv from "dotenv";
import { getCached, setCache } from "./cache";
dotenv.config({ path: ".env.local" });

const BASE_URL = "https://fuyao.aicubes.cn";
const MAX_RETRIES = 2;         // 仅限 429/5xx/网络错误，业务错误不重试
const RETRY_BASE_MS = 500;     // 500ms → 1000ms 退避

function getKey(): string {
  const key = process.env.FUYAO_API_KEY;
  if (!key) throw new Error("FUYAO_API_KEY 未配置");
  return key;
}

/** 网络类错误才重试；业务错误和参数错误直接抛出 */
function isRetryableError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return msg.includes("fetch failed") || msg.includes("network") || msg.includes("ECONN");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface FuyaoEnvelope {
  code?: number;
  message?: string;
  request_id?: string;
  data?: unknown;
}

/** 统一请求方法：带 request_id 与有界退避重试（仅 429/5xx/网络错误） */
export async function fuyaoGet<T = any>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v) url.searchParams.set(k, v);
    }
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        headers: { "X-api-key": getKey() },
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      if (isRetryableError(e) && attempt < MAX_RETRIES) {
        await sleep(RETRY_BASE_MS * 2 ** attempt);
        continue;
      }
      throw e;
    }

    const json = (await res.json().catch(() => null)) as FuyaoEnvelope | null;
    const requestId = json?.request_id ? ` (request_id=${json.request_id})` : "";
    const message = json?.message || `HTTP ${res.status}`;

    // HTTP 传输层错误：只对 429/5xx 退避重试
    if (!res.ok || !json || typeof json.code !== "number") {
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        await sleep(RETRY_BASE_MS * 2 ** attempt);
        continue;
      }
      throw new Error(`同花顺API错误 [${json?.code ?? res.status}]: ${message}${requestId}`);
    }

    // 业务错误：不重试
    if (json.code !== 0) {
      throw new Error(`同花顺API错误 [${json.code}]: ${message}${requestId}`);
    }

    return json.data as T;
  }

  throw new Error(`同花顺API请求失败（已重试 ${MAX_RETRIES} 次）: ${path}`);
}

/** 归一化为同花顺 thscode：600519 / sh600519 / 600519.SH 均可 */
export function normalizeThscode(raw: string): string {
  const code = raw.trim().toUpperCase();
  if (!code) return "";
  if (/^\d{6}$/.test(code)) {
    const suffix = code.startsWith("6")
      ? "SH"
      : code.startsWith("4") || code.startsWith("8")
        ? "BJ"
        : "SZ";
    return `${code}.${suffix}`;
  }
  if (/^[A-Z]{2}\d{6}$/.test(code)) {
    return `${code.slice(2)}.${code.slice(0, 2)}`;
  }
  return code;
}

/** 读多写少的 fuyao 快照缓存：新鲜缓存直接返回，拉取失败时回退软过期数据 */
async function cachedFuyao<T>(
  dataType: string,
  params: Record<string, string>,
  fetcher: () => Promise<T>
): Promise<T> {
  const cached = getCached<T>(dataType, params);
  if (cached && !cached.isStale) return cached.data;
  try {
    const data = await fetcher();
    setCache(dataType, data, params);
    return data;
  } catch (e) {
    if (cached) return cached.data;
    throw e;
  }
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

/** 个股异动原因列表（可选按标签过滤，短时缓存） */
export async function getAnomalyList(tagCodes?: string): Promise<{ timestamp: number; item: AnomalyItem[] }> {
  const params: Record<string, string> = tagCodes ? { tag_codes: tagCodes } : {};
  return cachedFuyao("fuyao_anomaly", params, () =>
    fuyaoGet("/api/a-share/special-data/anomaly-analysis-list", tagCodes ? { tag_codes: tagCodes } : undefined)
  );
}

/** 按股票查询异动原因 */
export async function getAnomalyByStock(thscodes: string): Promise<{ timestamp: number; item: AnomalyItem[] }> {
  return fuyaoGet("/api/a-share/special-data/anomaly-analysis-stock", { thscodes });
}

/** 涨停股票池（短时缓存，30s 内复用） */
export async function getLimitUpPool(): Promise<{ timestamp: number; item: LimitUpItem[] }> {
  return cachedFuyao("fuyao_limit_up", {}, () =>
    fuyaoGet("/api/a-share/special-data/limit-up-pool")
  );
}

/** 连板天梯（近30交易日，短时缓存） */
export async function getLimitUpLadder(): Promise<LimitUpLadderData> {
  return cachedFuyao("fuyao_limit_up_ladder", {}, () =>
    fuyaoGet("/api/a-share/special-data/limit-up-ladder")
  );
}

/** 热股榜单 Top30（短时缓存） */
export async function getHotStockList(level: "24h" | "1h" = "24h"): Promise<{ timestamp: number; item: HotStockItem[] }> {
  const params = { level };
  return cachedFuyao("fuyao_hot_stock", params, () =>
    fuyaoGet("/api/a-share/special-data/hot-stock-list", params)
  );
}

/** 飙升榜 Top30（period: day 日榜 / hour 小时榜，短时缓存） */
export async function getSkyrocketList(period: "day" | "hour" = "hour"): Promise<{ timestamp: number; item: HotStockItem[] }> {
  const params = { period };
  return cachedFuyao("fuyao_skyrocket", params, () =>
    fuyaoGet("/api/a-share/special-data/skyrocket-list", params)
  );
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
  const params: Record<string, string> = { board_type: boardType, ...(date ? { date } : {}) };
  return cachedFuyao("fuyao_dragon_tiger", params, () =>
    fuyaoGet("/api/a-share/special-data/dragon-tiger-list", params)
  );
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

// ===== 基金净值（折溢价计算用，2026-08-18 实测） =====
export interface FundNav {
  nav_date: number;   // 净值日期(毫秒时间戳；QDII 可能滞后 1-2 个交易日)
  unit_nav: number;   // 单位净值
  adj_nav: number;    // 复权净值
}

/**
 * 基金最新净值。fund_type: exchange(交易所 ETF/LOF) / otc(场外 .OF)。
 * 实测返回最新一条；接口有限流(429)，调用方必须缓存。
 */
export async function getFundNav(thscode: string, fundType: "exchange" | "otc" = "exchange"): Promise<FundNav | null> {
  const data = await fuyaoGet<{ timestamp: number; item: FundNav[] }>("/api/fund/performance/nav", {
    fund_type: fundType,
    thscode,
  });
  return data.item?.[0] ?? null;
}