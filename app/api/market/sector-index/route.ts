/** GET /api/market/sector-index?days=5 — 同花顺概念板块指数涨跌幅排行（近N日累计）
 *  数据源 ths_index_daily（ths_daily 接口，含 pct_change），概念清单 ths_index(cn_concept)。
 */
export async function GET(request: Request) {
  const days = Math.min(parseInt(new URL(request.url).searchParams.get("days") || "1"), 30);
  try {
    const { prisma } = await import("@/lib/db");
    const rows: any[] = await prisma.$queryRawUnsafe(
      // 起始交易日从交易日历取（review_calendar_days 一行/交易日，取数极快）；
      // 原实现是在 ths_index_daily 上 DESC OFFSET，该表只有 (ts_code,trade_date) 主键，
      // 会全表扫 288 万行；更要命的是窗口函数没有日期下界 → 要排 63 万行（实测 3.7s，市场页每次加载都挨）。
      `WITH bounds AS (
        SELECT COALESCE(
          (SELECT trade_date FROM review_calendar_days ORDER BY trade_date DESC LIMIT 1 OFFSET $1 - 1),
          '00000000'
        ) AS start_date
      ), concepts AS (
        SELECT thscode, name FROM ths_index WHERE tag = 'cn_concept'
      ), ranked AS (
        SELECT d.ts_code, d.trade_date, d.close, d.pct_change, d.vol,
          ROW_NUMBER() OVER (PARTITION BY d.ts_code ORDER BY d.trade_date DESC) AS rn
        FROM ths_index_daily d
        JOIN concepts c ON c.thscode = d.ts_code
        WHERE d.trade_date >= (SELECT start_date FROM bounds)
      )
      SELECT r.ts_code, c.name,
        MAX(CASE WHEN rn = 1 THEN close END) AS latest_close,
        AVG(pct_change) AS avg_pct_chg,
        SUM(pct_change) AS cum_pct_chg,
        MAX(CASE WHEN rn = 1 THEN pct_change END) AS latest_pct_chg,
        MAX(CASE WHEN rn = 1 THEN vol END) AS latest_vol,
        COUNT(*)::int AS days_count
      FROM ranked r
      JOIN concepts c ON c.thscode = r.ts_code
      GROUP BY r.ts_code, c.name
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
        latestAmount: null,
      })),
    });
  } catch (e: any) {
    console.error("[api/market/sector-index]", e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
