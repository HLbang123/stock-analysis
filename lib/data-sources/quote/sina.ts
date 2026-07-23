import { RealtimeQuote } from '@/types';
import { decodeGBK, buildQuoteResponse } from '@/lib/api-helpers';

/** 新浪实时行情（成交量单位：股，与腾讯的"手"存在既有差异，保持原行为） */
export async function fetchSinaQuote(symbol: string, signal: AbortSignal): Promise<RealtimeQuote | null> {
  try {
    const res = await fetch(`https://hq.sinajs.cn/list=${symbol}`, {
      headers: { Referer: 'https://finance.sina.com.cn' },
      signal,
    });
    if (!res.ok) return null;

    const text = decodeGBK(await res.arrayBuffer());
    const match = text.match(/="([^"]+)"/);
    if (!match) return null;

    const data = match[1].split(',');
    if (data.length < 32) return null;

    const price = parseFloat(data[3]);
    const preClose = parseFloat(data[2]);
    if (isNaN(price) || price === 0) return null;

    return buildQuoteResponse({
      symbol,
      name: data[0],
      price,
      preClose,
      open: parseFloat(data[1]),
      high: parseFloat(data[4]),
      low: parseFloat(data[5]),
      volume: parseInt(data[8]) || 0,
      amount: parseFloat(data[9]) || 0,
    });
  } catch {
    return null;
  }
}
