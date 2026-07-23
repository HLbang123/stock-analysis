import { RealtimeQuote } from '@/types';
import { buildQuoteResponse, normalizeMarketCode } from '@/lib/api-helpers';

/** 东方财富 secid 前缀：沪 1、深/北 0 */
function symbolToSecid(symbol: string): string | null {
  const parsed = normalizeMarketCode(symbol);
  if (!parsed) return null;
  const prefix = parsed.market === 'sh' ? '1' : '0';
  return `${prefix}.${parsed.pureCode}`;
}

/** 东方财富实时行情（成交量单位：手，与腾讯一致） */
export async function fetchEastmoneyQuote(symbol: string, signal: AbortSignal): Promise<RealtimeQuote | null> {
  const secid = symbolToSecid(symbol);
  if (!secid) return null;
  try {
    const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f44,f45,f46,f47,f48,f57,f58,f60&fltt=2&invt=2`;
    const res = await fetch(url, {
      headers: { Referer: 'https://quote.eastmoney.com' },
      signal,
    });
    if (!res.ok) return null;

    const json = await res.json();
    const d = json?.data;
    if (!d) return null;

    const price = Number(d.f43);
    const preClose = Number(d.f60);
    if (!isFinite(price) || price === 0) return null;

    return buildQuoteResponse({
      symbol,
      name: d.f58 ?? '',
      price,
      preClose,
      open: Number(d.f46),
      high: Number(d.f44),
      low: Number(d.f45),
      volume: Number(d.f47) || 0,
      amount: Number(d.f48) || 0,
    });
  } catch {
    return null;
  }
}
