/** GET /api/market/sector-index?days=5 — 申万行业指数涨跌幅排行（近N日累计） */
export async function GET(request: Request) {
  const days = Math.min(parseInt(new URL(request.url).searchParams.get("days") || "1"), 30);
  try {
    const { prisma } = await import("@/lib/db");
    const rows: any[] = await prisma.$queryRawUnsafe(
      `WITH recent AS (
        SELECT ts_code, trade_date, pct_chg, close, vol, amount,
          ROW_NUMBER() OVER (PARTITION BY ts_code ORDER BY trade_date DESC) AS rn
        FROM sw_index_daily
        WHERE trade_date >= (
          SELECT trade_date FROM sw_index_daily ORDER BY trade_date DESC LIMIT 1 OFFSET $1 - 1
        )
      )
      SELECT ts_code,
        MAX(CASE WHEN rn = 1 THEN close END) AS latest_close,
        AVG(pct_chg) AS avg_pct_chg,
        SUM(pct_chg) AS cum_pct_chg,
        MAX(CASE WHEN rn = 1 THEN pct_chg END) AS latest_pct_chg,
        MAX(CASE WHEN rn = 1 THEN vol END) AS latest_vol,
        MAX(CASE WHEN rn = 1 THEN amount END) AS latest_amount,
        COUNT(*)::int AS days_count
      FROM recent
      GROUP BY ts_code
      ORDER BY cum_pct_chg DESC NULLS LAST`,
      days
    );
    return Response.json({
      days,
      sectors: rows.map((r) => ({
        tsCode: r.ts_code,
        latestClose: r.latest_close != null ? Number(r.latest_close) : null,
        avgPctChg: r.avg_pct_chg != null ? Number(r.avg_pct_chg) : null,
        cumPctChg: r.cum_pct_chg != null ? Number(r.cum_pct_chg) : null,
        latestPctChg: r.latest_pct_chg != null ? Number(r.latest_pct_chg) : null,
        latestAmount: r.latest_amount != null ? Number(r.latest_amount) : null,
      })),
    });
  } catch (e: any) {
    console.error("[api/market/sector-index]", e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
