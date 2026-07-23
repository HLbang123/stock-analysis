import { KLineData } from '@/types';
import { normalizeMarketCode } from '@/lib/api-helpers';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/** 腾讯日K线（前复权 qfq，成交量单位：手） */
export async function fetchTencentKLine(code: string, days: number, signal: AbortSignal): Promise<KLineData[] | null> {
  try {
    const parsed = normalizeMarketCode(code) ?? { market: 'sh', pureCode: code };
    const { market, pureCode } = parsed;

    const url = `http://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${market}${pureCode},day,,,${days},qfq`;
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://finance.qq.com' },
      signal,
    });
    if (!res.ok) return null;

    const json = await res.json();
    const stockKey = `${market}${pureCode}`;
    const dayData = json.data?.[stockKey]?.day || json.data?.[stockKey]?.qfqday;
    if (!dayData || !Array.isArray(dayData)) return null;

    return dayData.map((item: string[]) => {
      const rawDate = String(item[0]);
      const cleaned = rawDate.replace(/-/g, '');
      const date = cleaned.length >= 8
        ? `${cleaned.slice(0, 4)}-${cleaned.slice(4, 6)}-${cleaned.slice(6, 8)}`
        : rawDate;
      return {
        date,
        open: parseFloat(item[1]),
        close: parseFloat(item[2]),
        high: parseFloat(item[3]),
        low: parseFloat(item[4]),
        volume: parseInt(item[5]) || 0,
      };
    });
  } catch {
    return null;
  }
}
