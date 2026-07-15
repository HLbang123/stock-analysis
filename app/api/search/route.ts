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

    // 过滤：只要A股（排除板块BK、指数ZS）
    const results = items
      .filter((item: any) => {
        const code = item.Code || '';
        // 只保留6位数字代码
        return /^\d{6}$/.test(code) && item.Classify !== 'BK' && item.Classify !== 'ZS';
      })
      .map((item: any) => {
        const code = item.Code;
        let market = 'sh';
        if (/^6/.test(code)) market = 'sh';
        else if (/^(0|3)/.test(code)) market = 'sz';
        else if (/^8/.test(code)) market = 'bj';

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
