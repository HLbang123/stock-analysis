/**
 * GET /api/ai-screen/[runId] — 取某次运行详情（含 picks）
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const { runId } = await params;
    const run = await prisma.aiScreenRun.findUnique({
      where: { id: runId },
      include: {
        picks: { orderBy: { rank: 'asc' } },
      },
    });
    if (!run) {
      return NextResponse.json({ error: '运行记录不存在' }, { status: 404 });
    }
    return NextResponse.json({ run });
  } catch (e: any) {
    console.error('[api/ai-screen/[runId]]', e);
    return NextResponse.json({ error: e.message || '查询失败' }, { status: 500 });
  }
}
