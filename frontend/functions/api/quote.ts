/**
 * GET /api/quote?codes=sh600519,sz000001
 * Real-time quotes — Sina primary, Tencent fallback.
 */
import { withCache } from '../lib/utils';
import { fetchSinaQuotes } from '../lib/sina';
import { fetchTencentQuotes } from '../lib/tencent';

export async function onRequestGet(context: any) {
  const url = new URL(context.request.url);
  const codesParam = url.searchParams.get('codes') || '';

  const codeList = codesParam.split(',').map((c: string) => c.trim()).filter(Boolean);
  if (codeList.length === 0) {
    return json({ error: '缺少codes参数' }, 400);
  }

  try {
    let quotes;
    try {
      quotes = await fetchSinaQuotes(codeList);
    } catch (sinaErr) {
      console.warn('Sina failed, trying Tencent:', sinaErr);
      try {
        quotes = await fetchTencentQuotes(codeList);
      } catch (tencentErr) {
        return json({ error: '行情数据获取失败，请稍后重试' }, 502);
      }
    }

    const headers = new Headers({ 'Content-Type': 'application/json' });
    withCache(headers, 3); // 3 second cache
    return new Response(JSON.stringify({ quotes }), { headers });

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
