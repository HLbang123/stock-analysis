import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

/**
 * GET /api/fund/profile?code=sh513100 — ETF 品种档案（fund_profiles）
 * 深度分析 ETF 分支用：资产类别 / T+0 / 涨跌幅限制 / 业绩基准。
 */

/** sina 格式(sh513100) → Tushare 格式(513100.SH) */
function toTushareCode(c: string): string {
  const m = c.match(/^([a-z]{2})(\d{6})$/i);
  return m ? `${m[2]}.${m[1].toUpperCase()}` : c;
}

export async function GET(request: NextRequest) {
  try {
    const code = new URL(request.url).searchParams.get('code');
    if (!code) return NextResponse.json({ error: '缺少 code' }, { status: 400 });

    const profile = await prisma.fundProfile.findUnique({
      where: { tsCode: toTushareCode(code) },
      select: {
        tsCode: true,
        name: true,
        fundType: true,
        investType: true,
        benchmark: true,
        listDate: true,
        assetClass: true,
        tPlus0: true,
        limitPct: true,
      },
    });

    return NextResponse.json({ profile });
  } catch (e: unknown) {
    console.error('[api/fund/profile]', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : '查询失败' }, { status: 500 });
  }
}
