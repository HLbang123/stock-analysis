import { NextRequest, NextResponse } from 'next/server';
import { normalizeMarketCode, decodeGBK, buildQuoteResponse } from '@/lib/api-helpers';

/** 实时行情代理 — 优先腾讯，失败回退新浪 */
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
    const quote = await fetchTencent(symbol);
    if (quote) return NextResponse.json(quote);

    const sinaQuote = await fetchSina(symbol);
    if (sinaQuote) return NextResponse.json(sinaQuote);

    return NextResponse.json({ error: '获取行情失败' }, { status: 502 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

async function fetchTencent(symbol: string) {
  try {
    const res = await fetch(`https://qt.gtimg.cn/q=${symbol}`, {
      headers: { Referer: 'https://gu.qq.com' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;

    const text = decodeGBK(await res.arrayBuffer());
    const match = text.match(/="([^"]+)"/);
    if (!match) return null;

    const data = match[1].split('~');
    if (data.length < 40) return null;

    const price = parseFloat(data[3]);
    const preClose = parseFloat(data[4]);
    if (isNaN(price) || price === 0) return null;

    return buildQuoteResponse({
      symbol,
      name: data[1],
      price,
      preClose,
      open: parseFloat(data[5]),
      high: parseFloat(data[33]),
      low: parseFloat(data[34]),
      volume: parseInt(data[36]) || 0,
      amount: parseFloat(data[37]) || 0,
    });
  } catch {
    return null;
  }
}

async function fetchSina(symbol: string) {
  try {
    const res = await fetch(`https://hq.sinajs.cn/list=${symbol}`, {
      headers: { Referer: 'https://finance.sina.com.cn' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;

    const text = decodeGBK(await res.arrayBuffer());
    const match = text.match(/="([^"]+)"/);
    if (!match) return null;

    const data = match[1].split(',');
    if (data.length < 32) return null;

    const price = parseFloat(data[3]);
    const preClose = parseFloat(data[2]);
    if (isNaN(price) || price === 0) return null;

    return buildQuoteResponse({
      symbol,
      name: data[0],
      price,
      preClose,
      open: parseFloat(data[1]),
      high: parseFloat(data[4]),
      low: parseFloat(data[5]),
      volume: parseInt(data[8]),
      amount: parseFloat(data[9]),
    });
  } catch {
    return null;
  }
}
