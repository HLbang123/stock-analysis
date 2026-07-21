/** GET /api/market/breadth?days=60 — 市场宽度近 N 日（时间序列，老→新） */
export async function GET(request: Request) {
  const days = Math.min(parseInt(new URL(request.url).searchParams.get("days") || "60"), 250);
  try {
    const { prisma } = await import("@/lib/db");
    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT trade_date, advance, decline, flat, limit_up, limit_down,
              new_high20, new_low20, above_ma55_count, above_ma55_ratio,
              strong_rps_count, strong_rps_ratio
       FROM market_breadth ORDER BY trade_date DESC LIMIT $1`,
      days
    );
    const items = rows.map((r) => ({
      date: r.trade_date,
      advance: r.advance, decline: r.decline, flat: r.flat,
      limitUp: r.limit_up, limitDown: r.limit_down,
      newHigh20: r.new_high20, newLow20: r.new_low20,
      aboveMa55Count: r.above_ma55_count, aboveMa55Ratio: r.above_ma55_ratio,
      strongRpsCount: r.strong_rps_count, strongRpsRatio: r.strong_rps_ratio,
    })).reverse(); // 老→新
    return Response.json({ count: items.length, items });
  } catch (e: any) {
    console.error("[api/market/breadth]", e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
