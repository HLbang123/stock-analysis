import { KLineData } from '@/types';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/** 新浪公开日K线（前复权 fq=1，成交量由股归一化为手 ÷100） */
export async function fetchSinaKLine(code: string, scale: number, days: number, signal: AbortSignal): Promise<KLineData[] | null> {
  try {
    const res = await fetch(
      `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${code}&scale=${scale}&ma=no&datalen=${days}&fq=1`,
      {
        headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn' },
        signal,
      }
    );
    if (!res.ok) return null;

    const json = await res.json();
    if (!Array.isArray(json) || json.length === 0) return null;

    return json.map((item: { day: string; open: string; close: string; high: string; low: string; volume: string }) => ({
      date: item.day,
      open: parseFloat(item.open),
      close: parseFloat(item.close),
      high: parseFloat(item.high),
      low: parseFloat(item.low),
      volume: Math.round(parseInt(item.volume) / 100) || 0,
    }));
  } catch {
    return null;
  }
}
