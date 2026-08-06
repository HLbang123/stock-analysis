import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

/**
 * GET /api/stock/history?code=sz002463&date=20260109 — 查某标的指定交易日行情
 * AI 对话工具 get_stock_history 用（原为服务器直查 daily_bars，浏览器直连后接口化）。
 * 返回 { row: { tradeDate, open, high, low, close, preClose, changePct, vol, amount } | null }
 */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  const date = request.nextUrl.searchParams.get('date');
  if (!code || !date) {
    return NextResponse.json({ error: '缺少 code / date 参数' }, { status: 400 });
  }
  try {
    const m = (code as string).match(/^([a-z]+)(\d+)$/i);
    if (!m) {
      return NextResponse.json({ error: '无效代码' }, { status: 400 });
    }
    const tsCode = `${m[2]}.${m[1].toUpperCase()}`;
    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT "tradeDate", open, high, low, close, pre_close, change_pct, vol, amount
       FROM daily_bars WHERE "tsCode" = $1 AND "tradeDate" = $2 LIMIT 1`,
      tsCode, date
    );
    if (!rows.length) {
      return NextResponse.json({ row: null });
    }
    const r = rows[0];
    return NextResponse.json({
      row: {
        tradeDate: r.tradeDate,
        open: r.open, high: r.high, low: r.low, close: r.close,
        preClose: r.pre_close, changePct: r.change_pct, vol: r.vol, amount: r.amount,
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message?.slice(0, 120) }, { status: 500 });
  }
}
