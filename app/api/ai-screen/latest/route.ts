import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { serializeRun } from '@/services/ai-screen/persist';
import { dbPickToAiPick } from '@/services/ai-screen/engine';

/**
 * GET /api/ai-screen/latest?strategyId=momentum — 某策略最近一次运行（含入选 picks）
 * 扫描页 AI 筛选 tab 用：打开即读最新结果，无需"运行"按钮。
 */
export async function GET(request: NextRequest) {
  try {
    const strategyId = new URL(request.url).searchParams.get('strategyId');
    if (!strategyId) {
      return NextResponse.json({ error: '缺少 strategyId' }, { status: 400 });
    }
    const run = await prisma.aiScreenRun.findFirst({
      where: { strategyId },
      orderBy: { barDate: 'desc' },
      include: { picks: { orderBy: { rank: 'asc' } } },
    });
    if (!run) {
      return NextResponse.json({ run: null });
    }
    return NextResponse.json({
      run: {
        ...serializeRun(run),
        picks: run.picks.filter((p) => p.rank != null).map(dbPickToAiPick),
      },
    });
  } catch (e: any) {
    console.error('[api/ai-screen/latest]', e);
    return NextResponse.json({ error: e.message || '查询失败' }, { status: 500 });
  }
}
