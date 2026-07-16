import { NextRequest, NextResponse } from 'next/server';

/**
 * 股票搜索代理 — 通过东方财富API搜索
 */
export async function GET(request: NextRequest) {
  const keyword = request.nextUrl.searchParams.get('keyword');
  if (!keyword) {
    return NextResponse.json({ error: '缺少 keyword 参数' }, { status: 400 });
  }

  try {
    const url = `https://searchadapter.eastmoney.com/api/suggest/get?input=${encodeURIComponent(keyword)}&type=14&count=15`;
    const res = await fetch(url, {
      headers: { Referer: 'https://www.eastmoney.com' },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return NextResponse.json([]);

    const data = await res.json();
    const items = data?.QuotationCodeTable?.Data || [];

    // 过滤：只要沪深A股
    const results = items
      .filter((item: any) => {
        const code = item.Code || '';
        if (!/^[036]\d{5}$/.test(code)) return false;
        if (['BK', 'ZS', 'ZQ', 'FJ', 'JJ'].includes(item.Classify || '')) return false;
        if ((item.Name || '').includes('债')) return false;
        // 排除"债券型"等类型
        if ((item.TypeName || '').includes('债券')) return false;
        if ((item.SecurityTypeName || '').includes('债')) return false;
        if (String(item.Type || '').length > 0 && !['1', '2', '6'].includes(String(item.Type))) return false;
        return true;
      })
      .map((item: any) => {
        const code = item.Code;
        let market = 'sh';
        if (/^6/.test(code)) market = 'sh';
        else if (/^(0|3)/.test(code)) market = 'sz';

        return {
          code: `${market}${code}`,
          name: item.Name || code,
          market,
          pureCode: code,
        };
      });

    return NextResponse.json(results);
  } catch {
    return NextResponse.json([]);
  }
}
