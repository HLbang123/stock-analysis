import { RealtimeQuote, KLineData } from '@/types';

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
    return data;
  } catch (error) {
    console.error('获取分时数据失败:', error);
    return [];
  }
}

/**
 * 股票搜索（通过服务端代理）
 */
export async function searchStocks(keyword: string): Promise<RealtimeQuote[]> {
  try {
    // 先通过东方财富搜索股票代码
    const res = await fetch(`/api/search?keyword=${encodeURIComponent(keyword)}`);
    if (!res.ok) return [];
    const results = await res.json();
    if (!Array.isArray(results) || results.length === 0) return [];

    // 对搜索结果获取实时行情
    const quotes = await Promise.all(
      results.slice(0, 10).map((r: { code: string }) => getRealtimeQuote(r.code))
    );

    return quotes.filter((q): q is RealtimeQuote => q !== null);
  } catch (error) {
    console.error('股票搜索失败:', error);
    return [];
  }
}

/**
 * 解析股票代码输入
 */
export function parseStockCode(input: string): { market: string; pureCode: string; fullCode: string } {
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
  } else if (/^6\d{5}$/.test(trimmed)) {
    market = 'sh';
    pureCode = trimmed;
  } else if (/^(0|3)\d{5}$/.test(trimmed)) {
    market = 'sz';
    pureCode = trimmed;
  } else if (/^8\d{5}$/.test(trimmed)) {
    market = 'bj';
    pureCode = trimmed;
  }

  return { market, pureCode, fullCode: `${market}${pureCode}` };
}
