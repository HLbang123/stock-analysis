/**
 * GET /api/ai-screen/[runId] — 取某次运行详情
 *
 * 默认只回入选 top-N(rank!=null,兼容历史数据)。
 * 可选查询参数(展示层过滤,不打分、不动 L1,胜率完整性不变):
 *   - sector: 申万行业 index_name
 *   - level:  L1(默认)/L2
 *   - board:  all(默认)/main/gem/star/bjse
 * 传 sector/board 时:从全候选池过滤符合的子集,按 screenScore 重切 top-N 返回。
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

/** ts_code 形如 "600000.SH"/"000001.SZ"/"830799.BJ",按市场板过滤 */
function matchBoard(tsCode: string, board: string): boolean {
  if (board === 'all') return true;
  const m = tsCode.match(/^(\d{6})\.(SH|SZ|BJ)$/);
  if (!m) return board === 'bjse' ? tsCode.endsWith('.BJ') : false;
  const [, code, ex] = m;
  switch (board) {
    case 'main':
      return (ex === 'SH' && code.startsWith('60')) || (ex === 'SZ' && /^00[0-3]/.test(code));
    case 'gem':
      return ex === 'SZ' && /^30[01]/.test(code);
    case 'star':
      return ex === 'SH' && /^68[89]/.test(code);
    case 'bjse':
      return ex === 'BJ';
    default:
      return true;
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const { runId } = await params;
    const sp = new URL(request.url).searchParams;
    const sector = sp.get('sector') || '';
    const level = sp.get('level') === 'L2' ? 'L2' : 'L1';
    const board = sp.get('board') || 'all';
    const filtered = !!(sector || board !== 'all');
    const limitRaw = parseInt(sp.get('limit') || '', 10);

    const run = await prisma.aiScreenRun.findUnique({
      where: { id: runId },
      include: { picks: { orderBy: { rank: 'asc' } } },
    });
    if (!run) {
      return NextResponse.json({ error: '运行记录不存在' }, { status: 404 });
    }

    // 展示数量:默认=入选数(每策略 maxOutput=20);limit 查询参数仅作安全上限兜底
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : run.pickCount || 20, 1), 30);

    let picks = run.picks as any[];
    if (filtered) {
      // 展示层过滤:在全候选池里按 sector+board 筛
      let sectorCodes: Set<string> | null = null;
      if (sector) {
        const members = await prisma.swIndexMember.findMany({
          where: { indexLevel: level, indexName: sector },
          select: { memberCode: true },
        });
        sectorCodes = new Set(members.map((m) => m.memberCode));
      }
      picks = picks.filter((p) => (sectorCodes ? sectorCodes.has(p.tsCode) : true)).filter((p) => matchBoard(p.tsCode, board));
    }
    // 按 finalScore 重切 limit(默认 limit=入选数时等价于 selected top-N)
    picks = picks
      .sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0))
      .slice(0, limit);

    return NextResponse.json({ run: { ...run, picks } });
  } catch (e: any) {
    console.error('[api/ai-screen/[runId]]', e);
    return NextResponse.json({ error: e.message || '查询失败' }, { status: 500 });
  }
}
