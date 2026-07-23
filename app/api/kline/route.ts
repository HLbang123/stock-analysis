import { NextRequest, NextResponse } from 'next/server';
import { withFallback } from '@/lib/data-sources/registry';
import { fetchTencentKLine } from '@/lib/data-sources/kline/tencent';
import { fetchSinaKLine } from '@/lib/data-sources/kline/sina';
import { fetchEastmoneyKLine } from '@/lib/data-sources/kline/eastmoney';

/**
 * K线数据代理 — 腾讯→东方财富→新浪，hedged 降级（慢源 3s 后并发）+ 健康熔断
 * 腾讯/东方财富为前复权日K（成交量:手）；新浪用 scale 参数（成交量由股归一化为手）
 */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  const days = parseInt(request.nextUrl.searchParams.get('days') || '120');
  const scale = parseInt(request.nextUrl.searchParams.get('scale') || '240');

  if (!code) {
    return NextResponse.json({ error: '缺少 code 参数' }, { status: 400 });
  }

  try {
    const klines = await withFallback([
      { id: 'tencent',   fetch: (s) => fetchTencentKLine(code, days, s) },
      { id: 'eastmoney', fetch: (s) => fetchEastmoneyKLine(code, days, s) },
      { id: 'sina',      fetch: (s) => fetchSinaKLine(code, scale, days, s) },
    ]);
    if (klines && klines.length > 0) return NextResponse.json(klines);

    return NextResponse.json([], { status: 200 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
