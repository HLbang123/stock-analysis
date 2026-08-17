import { RealtimeQuote } from '@/types';
import { decodeGBK, buildQuoteResponse } from '@/lib/api-helpers';

/** 解析腾讯 qt 字段串（~ 分隔，个股/指数/ETF 同布局）；无效返回 null */
function parseTencentFields(symbol: string, data: string[]): RealtimeQuote | null {
  if (data.length < 40) return null;

  const price = parseFloat(data[3]);
  const preClose = parseFloat(data[4]);
  if (isNaN(price) || price === 0) return null;

  // 字段[30]为行情自带时间戳（20260810150900）
  const ts = data[30];
  const updateTime = ts && ts.length >= 12
    ? `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)} ${ts.slice(8, 10)}:${ts.slice(10, 12)}`
    : undefined;

  return buildQuoteResponse({
    symbol,
    name: data[1],
    price,
    preClose,
    open: parseFloat(data[5]),
    high: parseFloat(data[33]),
    low: parseFloat(data[34]),
    volume: parseInt(data[36]) || 0,
    amount: parseFloat(data[37]) || 0,
    // 字段38 = 换手率(%)（腾讯 qt 自带，盘中实时）
    turnover: parseFloat(data[38]) || undefined,
    updateTime,
  });
}

/** 腾讯实时行情（成交量单位：手） */
export async function fetchTencentQuote(symbol: string, signal: AbortSignal): Promise<RealtimeQuote | null> {
  try {
    const res = await fetch(`https://qt.gtimg.cn/q=${symbol}`, {
      headers: { Referer: 'https://gu.qq.com' },
      signal,
    });
    if (!res.ok) return null;

    const text = decodeGBK(await res.arrayBuffer());
    const match = text.match(/="([^"]+)"/);
    if (!match) return null;

    return parseTencentFields(symbol, match[1].split('~'));
  } catch {
    return null;
  }
}

/**
 * 腾讯批量实时行情：单请求多代码（q=sh600519,sz000001,...），响应为
 * v_sh600519="...";\nv_sz000001="..."; 多行。建议单批 ≤50 只（URL 长度/上游稳定性）。
 * 返回成功解析的子集；整体失败返回 null（由调用方回落单码多源）。
 */
export async function fetchTencentBatchQuotes(symbols: string[], signal: AbortSignal): Promise<Map<string, RealtimeQuote> | null> {
  if (symbols.length === 0) return new Map();
  try {
    const res = await fetch(`https://qt.gtimg.cn/q=${symbols.join(',')}`, {
      headers: { Referer: 'https://gu.qq.com' },
      signal,
    });
    if (!res.ok) return null;

    const text = decodeGBK(await res.arrayBuffer());
    const out = new Map<string, RealtimeQuote>();
    for (const m of text.matchAll(/v_([a-z]{2}\d{6})="([^"]*)"/g)) {
      const q = parseTencentFields(m[1], m[2].split('~'));
      if (q) out.set(m[1], q);
    }
    return out;
  } catch {
    return null;
  }
}
