import { NextRequest, NextResponse } from 'next/server';

/**
 * K线数据代理 — 避免浏览器CORS限制
 */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  const days = parseInt(request.nextUrl.searchParams.get('days') || '120');
  const scale = parseInt(request.nextUrl.searchParams.get('scale') || '240');

  if (!code) {
    return NextResponse.json({ error: '缺少 code 参数' }, { status: 400 });
  }

  try {
    // 优先腾讯K线
    const klines = await fetchTencentKLine(code, days);
    if (klines && klines.length > 0) return NextResponse.json(klines);

    // 回退新浪K线
    const sinaKLines = await fetchSinaKLine(code, scale, days);
    if (sinaKLines && sinaKLines.length > 0) return NextResponse.json(sinaKLines);

    return NextResponse.json([], { status: 200 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

async function fetchTencentKLine(code: string, days: number) {
  try {
    let market = 'sh';
    let pureCode = code;
    if (code.startsWith('sh') || code.startsWith('sz') || code.startsWith('bj')) {
      market = code.substring(0, 2);
      pureCode = code.substring(2);
    } else if (/^6/.test(code)) {
      market = 'sh';
    } else {
      market = 'sz';
    }

    const url = `http://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${market}${pureCode},day,,,${days},qfq`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;

    const json = await res.json();
    const stockKey = `${market}${pureCode}`;
    const dayData = json.data?.[stockKey]?.day || json.data?.[stockKey]?.qfqday;

    if (!dayData || !Array.isArray(dayData)) return null;

    return dayData.map((item: string[]) => {
      const rawDate = String(item[0]);
      // 腾讯API可能返回 "2026-01-15" 或 "20260115"，统一转为 yyyy-MM-dd
      const cleaned = rawDate.replace(/-/g, '');
      const date = cleaned.length >= 8
        ? `${cleaned.slice(0, 4)}-${cleaned.slice(4, 6)}-${cleaned.slice(6, 8)}`
        : rawDate;
      return {
        date,
        open: parseFloat(item[1]),
        close: parseFloat(item[2]),
        high: parseFloat(item[3]),
        low: parseFloat(item[4]),
        volume: parseInt(item[5]) || 0,
      };
    });
  } catch {
    return null;
  }
}

async function fetchSinaKLine(code: string, scale: number, days: number) {
  try {
    const res = await fetch(
      `https://quotes.sina.cn/cn/api/quotes.php?symbol=${code}&datasource=kline&num=${days}`,
      {
        headers: { Referer: 'https://finance.sina.com.cn' },
        signal: AbortSignal.timeout(15000),
      }
    );
    if (!res.ok) return null;

    const text = await res.text();
    if (!text.includes('"ok":1')) return null;

    const match = text.match(/"klines":\s*(\[[\s\S]*?\])/);
    if (!match) return null;

    const rawKlines = JSON.parse(match[1]);
    return rawKlines.map((item: any) => ({
      date: item.d,
      open: parseFloat(item.o),
      close: parseFloat(item.c),
      high: parseFloat(item.h),
      low: parseFloat(item.l),
      volume: parseInt(item.v) || 0,
    }));
  } catch {
    return null;
  }
}
