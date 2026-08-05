import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

/**
 * 周回顾快照读取
 * GET /api/weekly-review?week=20260803  （weekStart=周一日期，缺省取最新一期）
 */

export async function GET(request: NextRequest) {
  try {
    const week = new URL(request.url).searchParams.get('week');
    const review = week
      ? await prisma.weeklyReview.findUnique({ where: { weekStart: week } })
      : await prisma.weeklyReview.findFirst({ orderBy: { weekStart: 'desc' } });
    if (!review) return NextResponse.json({ review: null });
    return NextResponse.json({ review: { weekStart: review.weekStart, payload: JSON.parse(review.payload), createdAt: review.createdAt } });
  } catch (e: any) {
    console.error('[api/weekly-review]', e);
    return NextResponse.json({ error: e.message || '查询失败' }, { status: 500 });
  }
}
