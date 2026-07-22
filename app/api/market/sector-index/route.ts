/** GET /api/market/sector-index?days=5 — 申万行业指数涨跌幅排行（近N日累计） */
export async function GET(request: Request) {
  const days = Math.min(parseInt(new URL(request.url).searchParams.get("days") || "1"), 30);
  try {
    const { prisma } = await import("@/lib/db");
    // pct_chg 列 sw_daily 不返回，从 close 用 LAG 计算（需全历史取窗口前一日 close）
    // 仅保留申万一级（L1）行业指数，并用 sw_index_member 补中文名
    const rows: any[] = await prisma.$queryRawUnsafe(
      `WITH l1 AS (
        SELECT DISTINCT index_code, index_name FROM sw_index_member WHERE index_level = 'L1'
      ), ranked AS (
        SELECT d.ts_code, d.trade_date, d.close, d.vol, d.amount,
          LAG(d.close) OVER (PARTITION BY d.ts_code ORDER BY d.trade_date) AS prev_close,
          ROW_NUMBER() OVER (PARTITION BY d.ts_code ORDER BY d.trade_date DESC) AS rn
        FROM sw_index_daily d
        JOIN l1 ON l1.index_code = d.ts_code
      ), recent AS (
        SELECT * FROM ranked
        WHERE trade_date >= (
          SELECT trade_date FROM sw_index_daily ORDER BY trade_date DESC LIMIT 1 OFFSET $1 - 1
        )
      )
      SELECT r.ts_code,
        l1.index_name AS name,
        MAX(CASE WHEN rn = 1 THEN close END) AS latest_close,
        AVG(CASE WHEN prev_close IS NOT NULL AND prev_close <> 0
                 THEN (close - prev_close) / prev_close * 100 END) AS avg_pct_chg,
        SUM(CASE WHEN prev_close IS NOT NULL AND prev_close <> 0
                 THEN (close - prev_close) / prev_close * 100 END) AS cum_pct_chg,
        MAX(CASE WHEN rn = 1 AND prev_close IS NOT NULL AND prev_close <> 0
                 THEN (close - prev_close) / prev_close * 100 END) AS latest_pct_chg,
        MAX(CASE WHEN rn = 1 THEN vol END) AS latest_vol,
        MAX(CASE WHEN rn = 1 THEN amount END) AS latest_amount,
        COUNT(*)::int AS days_count
      FROM recent r
      JOIN l1 ON l1.index_code = r.ts_code
      GROUP BY r.ts_code, l1.index_name
      ORDER BY cum_pct_chg DESC NULLS LAST`,
      days
    );
    return Response.json({
      days,
      sectors: rows.map((r) => ({
        tsCode: r.ts_code,
        name: r.name,
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
