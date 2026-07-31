import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

/**
 * 深度分析全局回测胜率统计（按 action × N 分组）
 * 胜率判定：买入看涨(returnPct>0=赢)、卖出看跌(returnPct<0=赢)、持有看震荡(|returnPct|<5=赢)
 */

function isWin(action: string, returnPct: number): boolean {
  if (action === '买入') return returnPct > 0;
  if (action === '卖出') return returnPct < 0;
  // 持有/其他：震荡判断，|涨跌|<5% 算赢
  return Math.abs(returnPct) < 5;
}

export async function GET(request: NextRequest) {
  try {
    const records = await prisma.deepAnalysisRecord.findMany({
      include: { evals: true },
    });

    // 按 action × nDays 聚合
    const groups: Record<string, Record<number, { count: number; wins: number; sumReturn: number }>> = {};
    for (const r of records) {
      for (const e of r.evals) {
        if (e.returnPct == null) continue;
        if (!groups[r.action]) groups[r.action] = {};
        const g = groups[r.action][e.nDays] ??= { count: 0, wins: 0, sumReturn: 0 };
        g.count++;
        if (isWin(r.action, e.returnPct)) g.wins++;
        g.sumReturn += e.returnPct;
      }
    }

    const stats = Object.entries(groups).map(([action, byN]) => ({
      action,
      byN: Object.entries(byN).map(([n, g]) => ({
        nDays: parseInt(n, 10),
        count: g.count,
        wins: g.wins,
        winRate: g.count > 0 ? Math.round((g.wins / g.count) * 1000) / 10 : 0,
        avgReturn: g.count > 0 ? Math.round((g.sumReturn / g.count) * 100) / 100 : 0,
      })),
    }));

    return NextResponse.json({ stats, totalRecords: records.length });
  } catch (e: any) {
    console.error('[api/ai/deep-eval/stats]', e);
    return NextResponse.json({ error: e.message || '统计失败' }, { status: 500 });
  }
}
