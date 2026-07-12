/**
 * East Money K-line service for Cloudflare Workers.
 */

const PERIOD_MAP: Record<string, number> = {
  daily: 101, weekly: 102, monthly: 103,
  '30min': 30, '60min': 60, '15min': 15, '5min': 5,
};

export async function fetchEastMoneyKline(
  code: string,
  period = 'daily',
  limit = 300,
  adjusted = 1
): Promise<any> {
  const { toEastMoney } = await import('../lib/utils');
  const secid = toEastMoney(code);
  const klt = PERIOD_MAP[period] || 101;
  const fqt = adjusted ? 1 : 0;

  const url = new URL('https://push2his.eastmoney.com/api/qt/stock/kline/get');
  url.searchParams.set('secid', secid);
  url.searchParams.set('fields1', 'f1,f2,f3,f4,f5,f6');
  url.searchParams.set('fields2', 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61');
  url.searchParams.set('klt', String(klt));
  url.searchParams.set('fqt', String(fqt));
  url.searchParams.set('end', '20500101');
  url.searchParams.set('lmt', String(limit));

  const resp = await fetch(url.toString());
  const data: any = await resp.json();

  if (!data || data.rc !== 0 || !data.data) {
    throw new Error(`East Money API error`);
  }

  const name = data.data.name || '';
  const stockCode = data.data.code || code;
  const klines = (data.data.klines || []).map((line: string) => {
    const parts = line.split(',');
    return {
      date: parts[0],
      open: parseFloat(parts[1]),
      close: parseFloat(parts[2]),
      high: parseFloat(parts[3]),
      low: parseFloat(parts[4]),
      volume: parseFloat(parts[5]),
      amount: parseFloat(parts[6]),
    };
  });

  return { code: stockCode, name, klines };
}
