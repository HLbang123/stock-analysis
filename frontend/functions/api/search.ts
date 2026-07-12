/**
 * GET /api/search?keyword=茅台
 * Stock search using East Money suggest API.
 */
import { withCache } from '../lib/utils';

export async function onRequestGet(context: any) {
  const { request } = context;
  const url = new URL(request.url);
  const keyword = url.searchParams.get('keyword') || '';

  if (!keyword.trim()) {
    return json({ results: [] });
  }

  try {
    const apiUrl = new URL('https://searchapi.eastmoney.com/api/suggest/get');
    apiUrl.searchParams.set('input', keyword.trim());
    apiUrl.searchParams.set('type', '14');
    apiUrl.searchParams.set('token', 'D43BF722C8E33BDC906FB84D85E326E8');
    apiUrl.searchParams.set('count', '20');

    const resp = await fetch(apiUrl.toString());
    const data: any = await resp.json();

    if (!data?.QuotationCodeTable?.Data) {
      return json({ results: [] });
    }

    const results = data.QuotationCodeTable.Data
      .filter((item: any) => item.SecurityTypeName === 'A股' || item.Market === '科创板')
      .map((item: any) => ({
        code: item.Code,
        market: item.Market === '上交所' ? 'sh' :
                item.Market === '深交所' ? 'sz' :
                item.Market === '北交所' ? 'bj' : 'sz',
        name: item.Name,
        type: item.SecurityTypeName || 'A股',
      }));

    const headers = new Headers({ 'Content-Type': 'application/json' });
    withCache(headers, 7200); // 2 hour cache
    return new Response(JSON.stringify({ results }), { headers });

  } catch (err: any) {
    return json({ results: [], error: err.message }, 500);
  }
}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
