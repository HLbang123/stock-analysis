import { RealtimeQuote } from '@/types';
import { decodeGBK, buildQuoteResponse } from '@/lib/api-helpers';

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

    const data = match[1].split('~');
    if (data.length < 40) return null;

    const price = parseFloat(data[3]);
    const preClose = parseFloat(data[4]);
    if (isNaN(price) || price === 0) return null;

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
    });
  } catch {
    return null;
  }
}
