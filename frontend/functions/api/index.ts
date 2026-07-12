/**
 * GET /api/index
 * Three major A-share indices.
 */
import { withCache } from '../lib/utils';
import { fetchSinaQuotes } from '../lib/sina';

export async function onRequestGet(context: any) {
  try {
    const indexCodes = ['s_sh000001', 's_sz399001', 's_sz399006'];
    const quotes = await fetchSinaQuotes(indexCodes);

    const indices = quotes.map((q: any) => ({
      code: q.fullCode,
      name: q.name,
      price: q.price,
      change: q.change,
      changePercent: q.changePercent,
      open: q.open,
      high: q.high,
      low: q.low,
      prevClose: q.prevClose,
    }));

    const headers = new Headers({ 'Content-Type': 'application/json' });
    withCache(headers, 3); // 3 second cache
    return new Response(JSON.stringify({ indices }), { headers });

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
