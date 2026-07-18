import { RealtimeQuote, KLineData } from '@/types';
import { detectMarket, parseCode as parseIdent } from '@/lib/identify';
import { getCached, setCache } from '@/lib/cache';

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
 * 股票搜索 — 本地优先，无结果再调API
 */
let cachedStocks: { c: string; n: string }[] | null = null;

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
