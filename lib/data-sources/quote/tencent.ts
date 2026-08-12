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

    // 字段[30]为行情自带时间戳（20260810150900），个股/指数同布局
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
  } catch {
    return null;
  }
}
