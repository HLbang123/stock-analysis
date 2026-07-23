import { KLineData } from '@/types';
import { normalizeMarketCode } from '@/lib/api-helpers';

/** 东方财富 secid 前缀：沪 1、深/北 0 */
function symbolToSecid(symbol: string): string | null {
  const parsed = normalizeMarketCode(symbol);
  if (!parsed) return null;
  const prefix = parsed.market === 'sh' ? '1' : '0';
  return `${prefix}.${parsed.pureCode}`;
}

/** 东方财富日K线（klt=101 日线、fqt=1 前复权，成交量单位：手）
 *  klines 每项为 "日期,开,收,高,低,成交量" 逗号字符串 */
export async function fetchEastmoneyKLine(code: string, days: number, signal: AbortSignal): Promise<KLineData[] | null> {
  const secid = symbolToSecid(code);
  if (!secid) return null;
  try {
    const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=1&lmt=${days}&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56`;
    const res = await fetch(url, {
      headers: { Referer: 'https://quote.eastmoney.com' },
      signal,
    });
    if (!res.ok) return null;

    const json = await res.json();
    const klines: string[] | undefined = json?.data?.klines;
    if (!Array.isArray(klines) || klines.length === 0) return null;

    return klines.map(line => {
      const [date, open, close, high, low, volume] = line.split(',');
      return {
        date,
        open: parseFloat(open),
        close: parseFloat(close),
        high: parseFloat(high),
        low: parseFloat(low),
        volume: parseInt(volume) || 0,
      };
    });
  } catch {
    return null;
  }
}
