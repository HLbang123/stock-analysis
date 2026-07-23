import { NextRequest, NextResponse } from 'next/server';
import { normalizeMarketCode } from '@/lib/api-helpers';
import { withFallback } from '@/lib/data-sources/registry';
import { fetchTencentQuote } from '@/lib/data-sources/quote/tencent';
import { fetchSinaQuote } from '@/lib/data-sources/quote/sina';
import { fetchEastmoneyQuote } from '@/lib/data-sources/quote/eastmoney';

/** 实时行情代理 — 腾讯→新浪→东方财富，hedged 降级（慢源 3s 后并发）+ 健康熔断 */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  if (!code) {
    return NextResponse.json({ error: '缺少 code 参数' }, { status: 400 });
  }

  const parsed = normalizeMarketCode(code);
  if (!parsed) {
    return NextResponse.json({ error: '无效的股票代码' }, { status: 400 });
  }
  const symbol = `${parsed.market}${parsed.pureCode}`;

  try {
    const quote = await withFallback([
      { id: 'tencent',   fetch: (s) => fetchTencentQuote(symbol, s) },
      { id: 'sina',      fetch: (s) => fetchSinaQuote(symbol, s) },
      { id: 'eastmoney', fetch: (s) => fetchEastmoneyQuote(symbol, s) },
    ]);
    if (quote) return NextResponse.json(quote);

    return NextResponse.json({ error: '获取行情失败' }, { status: 502 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
