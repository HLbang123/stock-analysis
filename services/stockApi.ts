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
 * 股票搜索（通过服务端代理，不预取行情避免香港→国内API延迟）
 */
export async function searchStocks(keyword: string): Promise<RealtimeQuote[]> {
  try {
    const res = await fetch(`/api/search?keyword=${encodeURIComponent(keyword)}`);
    if (!res.ok) return [];
    const results = await res.json();
    if (!Array.isArray(results) || results.length === 0) return [];

    // 直接返回搜索结果，不逐个获取行情（香港服务器连国内API太慢）
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
