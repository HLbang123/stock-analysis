import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

/**
 * GET /api/fund/daily?code=sh515880 — ETF 净值走势（fund_daily_bars 近 60 日）
 */

/** sina 格式(sh515880) → Tushare 格式(515880.SH) */
function toTushareCode(c: string): string {
  const m = c.match(/^([a-z]{2})(\d{6})$/i);
  return m ? `${m[2]}.${m[1].toUpperCase()}` : c;
}

export async function GET(request: NextRequest) {
  try {
    const code = new URL(request.url).searchParams.get('code');
    if (!code) return NextResponse.json({ error: '缺少 code' }, { status: 400 });

    const rows = await prisma.fundDaily.findMany({
      where: { tsCode: toTushareCode(code) },
      orderBy: { tradeDate: 'desc' },
      take: 60,
      select: { tradeDate: true, close: true, changePct: true },
    });
    return NextResponse.json({ bars: rows.reverse() });
  } catch (e: any) {
    console.error('[api/fund/daily]', e);
    return NextResponse.json({ error: e.message || '查询失败' }, { status: 500 });
  }
}
