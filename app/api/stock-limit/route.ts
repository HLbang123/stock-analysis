import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

/**
 * GET /api/stock-limit?tradeDate=20260805 — 当日全市场涨跌停价
 * 返回 { tradeDate, map: { "002415.SZ": { up, down, preClose } } }
 * 预警检查（checkAllRules）用：R01 涨停封板/炸板判定精确化；未命中回落规则推算。
 */

export async function GET(request: NextRequest) {
  try {
    const tradeDate = new URL(request.url).searchParams.get('tradeDate');
    if (!tradeDate) {
      const latest = await prisma.stockLimit.findFirst({ orderBy: { tradeDate: 'desc' }, select: { tradeDate: true } });
      if (!latest) return NextResponse.json({ map: {} });
      return NextResponse.json({ tradeDate: latest.tradeDate, map: {} });
    }
    const rows = await prisma.stockLimit.findMany({
      where: { tradeDate },
      select: { tsCode: true, preClose: true, limitUp: true, limitDown: true },
    });
    const map: Record<string, { up: number; down: number; preClose: number | null }> = {};
    for (const r of rows) {
      if (r.limitUp == null && r.limitDown == null) continue;
      map[r.tsCode] = { up: r.limitUp ?? 0, down: r.limitDown ?? 0, preClose: r.preClose ?? null };
    }
    return NextResponse.json({ tradeDate, map });
  } catch (e: any) {
    console.error('[api/stock-limit]', e);
    return NextResponse.json({ error: e.message || '查询失败' }, { status: 500 });
  }
}
