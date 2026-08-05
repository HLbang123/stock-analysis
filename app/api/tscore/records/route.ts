import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

/**
 * 波段评分(做T)信号在线落库
 * POST: 每次算完因子分静默写一条（同票同日同时刻 upsert 覆盖），失败不阻断前端。
 *   body: { tsCode, stockName, tradeDate, minuteOfDay, price, buyScore, sellScore, buyFactors, sellFactors, degraded }
 */

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { tsCode, stockName, tradeDate, minuteOfDay, price, buyScore, sellScore, buyFactors, sellFactors, degraded } = body;
    if (!tsCode || !tradeDate) {
      return NextResponse.json({ ok: false });
    }

    await prisma.tScoreRecord.upsert({
      where: { tsCode_tradeDate_minuteOfDay: { tsCode, tradeDate, minuteOfDay: minuteOfDay ?? 0 } },
      create: {
        tsCode, stockName: stockName ?? null, tradeDate,
        minuteOfDay: minuteOfDay ?? null,
        price: price ?? null,
        buyScore: buyScore ?? null,
        sellScore: sellScore ?? null,
        buyFactors: buyFactors ? JSON.stringify(buyFactors) : null,
        sellFactors: sellFactors ? JSON.stringify(sellFactors) : null,
        degraded: degraded ?? false,
        createdAt: new Date().toISOString(),
      },
      update: {
        stockName: stockName ?? null,
        minuteOfDay: minuteOfDay ?? null,
        price: price ?? null,
        buyScore: buyScore ?? null,
        sellScore: sellScore ?? null,
        buyFactors: buyFactors ? JSON.stringify(buyFactors) : null,
        sellFactors: sellFactors ? JSON.stringify(sellFactors) : null,
        degraded: degraded ?? false,
      },
    });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error('[api/tscore/records POST]', e);
    return NextResponse.json({ error: e.message || '落库失败' }, { status: 500 });
  }
}
