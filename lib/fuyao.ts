/**
 * 同花顺金融数据 API 客户端
 * 文档：https://fuyao.aicubes.cn/docs
 * 免费接口，key 从 FUYAO_API_KEY 环境变量读取
 */

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

/** 飙升榜 Top30 */
export async function getSkyrocketList(level: "24h" | "1h" = "1h"): Promise<{ timestamp: number; item: HotStockItem[] }> {
  return fuyaoGet("/api/a-share/special-data/skyrocket-list", { level });
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
