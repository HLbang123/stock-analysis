import { NextRequest, NextResponse } from 'next/server';
import { detectMarket } from '@/lib/identify';
import { fetchWithRetry } from '@/lib/api-helpers';

/** 股票搜索代理 — 东方财富主源 + 新浪备用 */
export async function GET(request: NextRequest) {
  const keyword = request.nextUrl.searchParams.get('keyword');
  if (!keyword) {
    return NextResponse.json({ error: '缺少 keyword 参数' }, { status: 400 });
  }

  const results = await trySearch(keyword);
  return NextResponse.json(results);
}

async function trySearch(keyword: string) {
  const encoded = encodeURIComponent(keyword);

  // 主源：东方财富
  const eastUrl = `https://searchadapter.eastmoney.com/api/suggest/get?input=${encoded}&type=14&count=15`;
  const eastRes = await fetchWithRetry(eastUrl, {
    headers: { Referer: 'https://www.eastmoney.com' },
  });

  if (eastRes) {
    const data = await eastRes.json();
    const items = data?.QuotationCodeTable?.Data || [];
    if (items.length > 0) return filterResults(items);
  }

  // 备用源：新浪
  const sinaUrl = `https://suggest3.sinajs.cn/suggest/type=11,12,13,14&key=${encoded}`;
  const sinaRes = await fetchWithRetry(sinaUrl, {
    headers: { Referer: 'https://finance.sina.com.cn' },
  });

  if (sinaRes) {
    const text = await sinaRes.text();
    // 新浪返回格式：var xxx="代码,名称,类型;..."
    const match = text.match(/"([^"]*)"/);
    if (match) {
      const items = match[1].split(';').filter(Boolean).map(s => {
        const parts = s.split(',');
        return { Code: parts[0], Name: parts[1] };
      });
      if (items.length > 0) return filterResults(items);
    }
  }

  return [];
}

function filterResults(items: any[]) {
  return items
    .filter((item: any) => {
      const code = item.Code || '';
      // 允许个股代码 + ETF代码
      if (!/^([036]\d{5}|51\d{4}|588\d{3}|159\d{3})$/.test(code)) return false;
      if (['BK', 'ZS', 'ZQ', 'FJ', 'JJ'].includes(item.Classify || '')) return false;
      if ((item.Name || '').includes('债')) return false;
      return true;
    })
    .map((item: any) => {
      const code = item.Code;
      const market = detectMarket(code) || 'sh';

      return {
        code: `${market}${code}`,
        name: item.Name || code,
        market,
        pureCode: code,
      };
    });
}
