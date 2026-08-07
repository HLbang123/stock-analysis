import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

/**
 * 周回顾快照读取
 * GET /api/weekly-review?week=20260803  （weekStart=周一日期，缺省取最新一期）
 * GET /api/weekly-review?meta=1         （只返回最新一期的 weekStart + generatedAt，
 *                                          首页角标用，避免每次加载都拉完整 payload）
 */

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const week = url.searchParams.get('week');
    const metaOnly = url.searchParams.get('meta') === '1';
    const review = week
      ? await prisma.weeklyReview.findUnique({ where: { weekStart: week } })
      : await prisma.weeklyReview.findFirst({ orderBy: { weekStart: 'desc' } });
    if (!review) return NextResponse.json({ review: null });
    const payload = JSON.parse(review.payload);
    if (metaOnly) {
      // 只回元信息，不整包回传（周报 payload 可能 10KB+，首页角标只需要 generatedAt）
      return NextResponse.json({ review: { weekStart: review.weekStart, generatedAt: payload.generatedAt } });
    }
    return NextResponse.json({ review: { weekStart: review.weekStart, payload, createdAt: review.createdAt } });
  } catch (e: any) {
    console.error('[api/weekly-review]', e);
    return NextResponse.json({ error: e.message || '查询失败' }, { status: 500 });
  }
}
