import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

/**
 * GET /api/daily-brief?type=morning&date=20260810 — 每日简报
 * type: morning=盘前提示 / daily=盘后日报；date 缺省取最近一条
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const type = searchParams.get('type') as 'morning' | 'daily' | null;
    const date = searchParams.get('date');

    if (!type || !['morning', 'daily'].includes(type)) {
      return NextResponse.json({ error: 'type 必须为 morning 或 daily' }, { status: 400 });
    }

    const brief = date
      ? await prisma.dailyBrief.findUnique({ where: { briefDate_type: { briefDate: date, type } } })
      : await prisma.dailyBrief.findFirst({ where: { type }, orderBy: { briefDate: 'desc' } });

    if (!brief) {
      return NextResponse.json({ brief: null });
    }
    return NextResponse.json({ brief: { ...brief, payload: JSON.parse(brief.payload) } });
  } catch (e: any) {
    console.error('[api/daily-brief]', e);
    return NextResponse.json({ error: e.message || '查询失败' }, { status: 500 });
  }
}
