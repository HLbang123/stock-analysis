import { RealtimeQuote, KLineData } from '@/types';
import { detectMarket, parseCode as parseIdent, getMarketStatus } from '@/lib/identify';
import { getCached, setCache } from '@/lib/cache';
import type { ChipDistribution } from '@/lib/chip';

/**
 * 获取实时行情（通过服务端代理，避免浏览器CORS限制）
 */
export async function getRealtimeQuote(code: string): Promise<RealtimeQuote | null> {
  try {
    const res = await fetch(`/api/quote?code=${encodeURIComponent(code)}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.error) return null;
    return data as RealtimeQuote;
  } catch (error) {
    console.error('获取行情失败:', error);
    return null;
  }
}

/**
 * 获取K线数据（通过服务端代理）
 */
export async function getKLineSina(
  symbol: string,
  scale: number = 240,
  dataLen: number = 120
): Promise<KLineData[]> {
  try {
    const res = await fetch(
      `/api/kline?code=${encodeURIComponent(symbol)}&scale=${scale}&days=${dataLen}`
    );
    if (!res.ok) return [];
    const data = await res.json();
    if (data.error) return [];
    return data as KLineData[];
  } catch (error) {
    console.error('获取K线失败:', error);
    return [];
  }
}

/**
 * 批量实时行情（/api/quotes，腾讯多代码+服务端 5s 缓存）。
 * 自选/分享详情等整页刷新用：400 只 = 1 次请求，替代逐只 getRealtimeQuote。
 * 返回 code → quote；缺失即该票拉取失败（调用方按无行情处理）。
 */
export async function getBatchQuotes(codes: string[]): Promise<Map<string, RealtimeQuote>> {
  if (codes.length === 0) return new Map();
  try {
    const res = await fetch(`/api/quotes?codes=${encodeURIComponent(codes.join(','))}`);
    if (!res.ok) return new Map();
    const json = await res.json();
    return new Map<string, RealtimeQuote>(Object.entries(json.quotes ?? {}));
  } catch (error) {
    console.error('批量获取行情失败:', error);
    return new Map();
  }
}

/**
 * 批量日K（/api/kline/batch，daily_bars 出数，前复权，不打上游）。
 * DB 未覆盖的品种（ETF/北交所等）不在返回里，调用方对缺失代码回落 getKLineSina 逐只拉。
 */
export async function getBatchKLines(codes: string[], days = 120): Promise<Map<string, KLineData[]>> {
  if (codes.length === 0) return new Map();
  try {
    const res = await fetch(`/api/kline/batch?codes=${encodeURIComponent(codes.join(','))}&days=${days}`);
    if (!res.ok) return new Map();
    const json = await res.json();
    return new Map<string, KLineData[]>(Object.entries(json.klines ?? {}));
  } catch (error) {
    console.error('批量获取K线失败:', error);
    return new Map();
  }
}

/**
 * 获取分时数据（通过服务端代理）
 */
export async function getMinuteData(code: string): Promise<{ time: string; price: number; volume: number; avgPrice: number }[]> {
  try {
    const res = await fetch(`/api/minute?code=${encodeURIComponent(code)}`);
    if (!res.ok) return [];
    const data = await res.json();
    if (data.error) return [];
    // 去重：腾讯API可能返回重复时间点
    const seen = new Set();
    return data.filter((p: { time: string }) => {
      if (seen.has(p.time)) return false;
      seen.add(p.time);
      return true;
    });
  } catch (error) {
    console.error('获取分时数据失败:', error);
    return [];
  }
}

/**
 * 获取筹码分布（通过 /api/chip 服务端取 daily_bars 换手率转移模型结果）
 * 失败/数据不足返回 null（调用方按 chip=null 处理，R13/R14 不触发）
 */
export async function getChipData(code: string, days = 90): Promise<ChipDistribution | null> {
  try {
    const res = await fetch(`/api/chip?code=${encodeURIComponent(code)}&days=${days}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.error) return null;
    return data as ChipDistribution;
  } catch {
    return null;
  }
}

/**
 * 股票搜索 — 本地优先，无结果再调API
 */
let cachedStocks: { c: string; n: string; industry?: string }[] | null = null;

/**
 * 从本地缓存获取股票行业分类
 */
export function getIndustry(code: string): string {
  const pure = code.replace(/^(sh|sz|bj)/i, '');
  const found = cachedStocks?.find(s => s.c === pure);
  return found?.industry || '';
}

/**
 * 获取市场状态文案（含节假日校验）
 * 优先调用服务端 /api/market-status（基于 Tushare 交易日历），
 * 失败时降级到本地周末判断
 */
export async function fetchMarketStatusNote(): Promise<string> {
  try {
    const res = await fetch('/api/market-status');
    if (res.ok) {
      const data = await res.json();
      if (data?.note) return data.note;
    }
  } catch {
    // 网络失败 → 降级
  }
  return getMarketStatus().note;
}

export async function searchStocks(keyword: string): Promise<RealtimeQuote[]> {
  const kw = keyword.trim().toLowerCase();

  // 本地搜索
  if (!cachedStocks) {
    try {
      const res = await fetch('/stocks.json');
      if (res.ok) cachedStocks = await res.json();
    } catch {}
  }

  if (cachedStocks) {
    const localResults = cachedStocks
      .filter(s => s.c.includes(kw) || s.n.toLowerCase().includes(kw))
      .slice(0, 15);
    if (localResults.length > 0) {
      return localResults.map(s => {
        const market = detectMarket(s.c) || 'sh';
        return {
          code: `${market}${s.c}`,
          name: s.n,
          price: 0, open: 0, high: 0, low: 0, preClose: 0,
          volume: 0, amount: 0, change: 0, changePercent: 0,
          updateTime: '',
        };
      });
    }
  }

  // API 兜底
  try {
    const res = await fetch(`/api/search?keyword=${encodeURIComponent(keyword)}`);
    if (!res.ok) return [];
    const results = await res.json();
    if (!Array.isArray(results) || results.length === 0) return [];

    return results.slice(0, 10).map((r: { code: string; name: string }) => ({
      code: r.code,
      name: r.name,
      price: 0, open: 0, high: 0, low: 0, preClose: 0,
      volume: 0, amount: 0, change: 0, changePercent: 0,
      updateTime: '',
    }));
  } catch (error) {
    console.error('股票搜索失败:', error);
    return [];
  }
}

/**
 * 解析股票代码输入
 */
export function parseStockCode(input: string): { market: string; pureCode: string; fullCode: string } {
  const parsed = parseIdent(input);
  if (parsed) return parsed;
  // 回退：无法识别市场时，保留原有逻辑
  const trimmed = input.trim().toLowerCase();
  let market = 'sh';
  let pureCode = trimmed;
  if (trimmed.startsWith('sh')) {
    market = 'sh';
    pureCode = trimmed.substring(2);
  } else if (trimmed.startsWith('sz')) {
    market = 'sz';
    pureCode = trimmed.substring(2);
  } else if (trimmed.startsWith('bj')) {
    market = 'bj';
    pureCode = trimmed.substring(2);
  }
  return { market, pureCode, fullCode: `${market}${pureCode}` };
}

// ===== 缓存包装（Phase 3.1）=====

/**
 * 缓存版 getRealtimeQuote
 * 行情 TTL=30s，maxAge=3min
 */
export async function getRealtimeQuoteCached(code: string): Promise<RealtimeQuote | null> {
  const key = { code };
  const cached = getCached<RealtimeQuote>('quote', key);
  if (cached && !cached.isStale) return cached.data;

  const fresh = await getRealtimeQuote(code);
  if (fresh) {
    setCache('quote', fresh, key);
    return fresh;
  }
  // 降级到过期缓存
  if (cached) return cached.data;
  return null;
}

// ===== 市场指数实时行情 =====
// 走个股同一 /api/quote 通道（腾讯/新浪 parser 对指数字段布局实测兼容，2026-08-10 验证）。
// 用途：深度分析「今日大盘」块——tushare 指数数据盘后才有，盘中只能取 T-1。

export const MARKET_INDICES = [
  { code: 'sh000001', name: '上证综指' },
  { code: 'sz399001', name: '深证成指' },
  { code: 'sz399006', name: '创业板指' },
  { code: 'sh000016', name: '上证50' },
  { code: 'sh000905', name: '中证500' },
  { code: 'sz399005', name: '中小板指' },
] as const;

export interface MarketIndexQuote {
  code: string;
  name: string;
  price: number;
  changePercent: number;
  /** 行情自带时间（YYYY-MM-DD HH:mm），非交易日为最近交易日收盘时间 */
  updateTime: string;
}

/** 六大指数实时行情（并行，各自走 hedged fallback；失败指数静默丢弃） */
export async function getMarketIndexQuotes(): Promise<MarketIndexQuote[]> {
  const results: (MarketIndexQuote | null)[] = await Promise.all(MARKET_INDICES.map(async (idx) => {
    const q = await getRealtimeQuoteCached(idx.code);
    if (!q || !q.price) return null;
    return {
      code: idx.code,
      name: idx.name,
      price: q.price,
      changePercent: q.changePercent,
      updateTime: q.updateTime || '',
    };
  }));
  return results.filter((q): q is MarketIndexQuote => q !== null);
}

/**
 * 缓存版 getKLineSina
 * 日K TTL=5min，maxAge=15min
 */
export async function getKLineSinaCached(symbol: string, scale: number = 240, dataLen: number = 120): Promise<KLineData[]> {
  const key = { code: symbol, scale, dataLen };
  const cached = getCached<KLineData[]>('kline_daily', key);
  if (cached && !cached.isStale) return cached.data;

  const fresh = await getKLineSina(symbol, scale, dataLen);
  if (fresh.length > 0) {
    setCache('kline_daily', fresh, key);
    return fresh;
  }
  if (cached) return cached.data;
  return [];
}

/**
 * 缓存版 getMinuteData
 * 分时 TTL=2min，maxAge=10min
 */
export async function getMinuteDataCached(code: string): Promise<{ time: string; price: number; volume: number; avgPrice: number }[]> {
  const key = { code };
  const cached = getCached<{ time: string; price: number; volume: number; avgPrice: number }[]>('minute_data', key);
  if (cached && !cached.isStale) return cached.data;

  const fresh = await getMinuteData(code);
  if (fresh.length > 0) {
    setCache('minute_data', fresh, key);
    return fresh;
  }
  if (cached) return cached.data;
  return [];
}
