/**
 * 大盘/市场数据的 API 响应类型契约 — 收敛 app/market、stock 详情里的 any。
 * 与各 route.ts 的实际返回结构对齐（字段名以 route 为准）。
 */

// ── /api/market/breadth ──────────────────────────────────────────────
export interface BreadthItem {
  date: string;
  advance: number; decline: number; flat: number;
  limitUp: number; limitDown: number;
  newHigh20: number; newLow20: number;
  aboveMa55Count: number; aboveMa55Ratio: number;
  rpsImproveRatio: number | null;
}
export interface BreadthResp { count: number; items: BreadthItem[] }

// ── /api/market/northbound ───────────────────────────────────────────
export interface NorthboundItem { date: string; northMoney: number | null; [k: string]: any }
export interface NorthboundResp { count?: number; items: NorthboundItem[] }

// ── /api/market/margin ───────────────────────────────────────────────
export interface MarginItem { date: string; rzye: number | null; netChange?: number | null; [k: string]: any }
export interface MarginResp { count?: number; items: MarginItem[] }

// ── /api/rps/sectors ─────────────────────────────────────────────────
export interface RpsSectorItem { industry: string; ratio: number; count?: number; [k: string]: any }
export interface RpsSectorsResp { sectors: RpsSectorItem[] }

// ── /api/market/sector-flow ──────────────────────────────────────────
export interface SectorFlowItem { industry: string; totalNet: number | null; stockCount: number; [k: string]: any }
export interface SectorFlowResp { sectors: SectorFlowItem[] }

// ── /api/market/sector-index ─────────────────────────────────────────
export interface SectorIndexItem { tsCode: string; name?: string; latestPctChg: number | null; [k: string]: any }
export interface SectorIndexResp { sectors: SectorIndexItem[] }

// ── /api/market/index-valuation ──────────────────────────────────────
export interface IndexValuationHistory { date: string; pe: number | null; [k: string]: any }
export interface IndexValuationResp {
  name?: string;
  currentPeTtm?: number | null;
  currentPb?: number | null;
  percentile?: number | null;
  history?: IndexValuationHistory[];
  error?: string;
}

// ── /api/limit-up ────────────────────────────────────────────────────
export interface LimitUpItem {
  tsCode: string; name: string;
  limitTimes?: number; firstTime?: string; openTimes?: number;
  fdAmount?: number | null; upStat?: string; [k: string]: any;
}
export interface LimitUpResp {
  source?: 'ths' | 'tushare';
  tradeDate?: string | null;
  fallback?: boolean;
  count: { up: number; down: number | null; broken: number | null };
  items: { up: LimitUpItem[]; down?: LimitUpItem[]; broken?: LimitUpItem[] };
  error?: string;
}

// ── /api/fuyao/hot-stocks ────────────────────────────────────────────
export interface HotStockItem {
  thscode: string; name: string; rank: number;
  rank_trend?: 'up' | 'down' | 'flat'; rank_change?: number; heat?: number | string; [k: string]: any;
}
export interface HotStocksResp {
  hot?: { item?: HotStockItem[] };
  skyrocket?: { item?: HotStockItem[] };
  error?: string;
}

// ── /api/stock/rps ───────────────────────────────────────────────────
export interface StockRpsResp {
  rps20?: number | null; rps60?: number | null; rps120?: number | null; rps250?: number | null;
  calcDate?: string | null; // YYYYMMDD，rps_scores 盘后计算，盘中恒为 T-1
  error?: string; [k: string]: any;
}

// ── /api/fuyao/anomaly ───────────────────────────────────────────────
export interface FuyaoAnomalyResp {
  item?: { tag_name?: string; [k: string]: any }[];
  error?: string;
}

// ── /api/fuyao/fund ──────────────────────────────────────────────────
export interface FuyaoFundResp {
  holdings?: any[];
  profile?: { fund_name?: string; [k: string]: any };
  error?: string; [k: string]: any;
}

// ── /api/tushare/stock-data ──────────────────────────────────────────
export interface TushareStockDataResp {
  success: boolean;
  data?: any;
  error?: string;
}
