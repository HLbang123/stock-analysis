import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

/**
 * GET /api/deep-analysis/regime — 最新 review_calendar_days 三态（B1 口径统一专用）。
 * 只读 review_calendar_days，取最新一条 trade_date 的 regime/regime_day（无未来数据）。
 * 查不到或异常时返回 source='fallback' 且 regime=null，由调用方回退旧 breadth 口径并明确日志。
 * 不新增数据库 schema；不改变任何写库逻辑。
 */
export async function GET() {
  try {
    const rows = await prisma.$queryRawUnsafe<{ trade_date: string; regime: string | null; regime_day: number | null }[]>(
      "SELECT trade_date, regime, regime_day FROM review_calendar_days ORDER BY trade_date DESC LIMIT 1"
    );
    const r = rows[0];
    if (r && r.regime && ['attack', 'neutral', 'defense'].includes(r.regime)) {
      return NextResponse.json({
        regime: r.regime,
        regimeDay: r.regime_day,
        tradeDate: r.trade_date,
        source: 'review-calendar',
      });
    }
    return NextResponse.json({ regime: null, regimeDay: null, tradeDate: r?.trade_date ?? null, source: 'fallback' });
  } catch (e: any) {
    console.error('[api/deep-analysis/regime]', e);
    return NextResponse.json({ regime: null, regimeDay: null, tradeDate: null, source: 'fallback' });
  }
}
