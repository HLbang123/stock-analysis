/**
 * GET /api/kline?code=sh600519&period=daily&limit=300&adjusted=1
 * K-line historical data from East Money.
 */
import { withCache } from '../lib/utils';
import { fetchEastMoneyKline } from '../lib/eastmoney';

export async function onRequestGet(context: any) {
  const url = new URL(context.request.url);
  const code = url.searchParams.get('code') || '';
  const period = url.searchParams.get('period') || 'daily';
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '300'), 500);
  const adjusted = url.searchParams.get('adjusted') !== '0' ? 1 : 0;

  if (!code) {
    return json({ error: '缺少code参数' }, 400);
  }

  const validPeriods = ['daily', 'weekly', 'monthly', '30min', '60min', '15min', '5min'];
  const p = validPeriods.includes(period) ? period : 'daily';

  try {
    const data = await fetchEastMoneyKline(code, p, limit, adjusted);

    const headers = new Headers({ 'Content-Type': 'application/json' });
    withCache(headers, 300); // 5 minute cache
    return new Response(JSON.stringify(data), { headers });

  } catch (err: any) {
    return json({ error: err.message }, 500);
  }
}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
