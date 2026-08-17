import { NextRequest, NextResponse } from 'next/server';
import { normalizeMarketCode } from '@/lib/api-helpers';
import { getQuoteCached } from '@/lib/server-quote-cache';

/** 实时行情代理 — 腾讯→新浪→东方财富 hedged 降级，外加 5s 缓存 + 在途去重（与 /api/quotes 共用缓存） */
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
    const quote = await getQuoteCached(symbol);
    if (quote) return NextResponse.json(quote);

    return NextResponse.json({ error: '获取行情失败' }, { status: 502 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
