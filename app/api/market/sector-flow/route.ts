/**
 * GET /api/market/sector-flow?days=5 — 板块资金流向（按行业聚合主力净流入）
 * 返回近 N 日各行业的主力净流入额，降序排列
 */
export async function GET(request: Request) {
  const days = Math.min(parseInt(new URL(request.url).searchParams.get("days") || "5"), 30);
  try {
    const { prisma } = await import("@/lib/db");
    // 取最近 N 个交易日的 moneyflow，按 industry 聚合
    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT s.industry,
              COUNT(DISTINCT m.ts_code)::int AS stock_count,
              SUM(m.net_mf_amount) AS total_net,
              SUM(m.buy_elg_amount) AS total_elg,
              SUM(m.buy_lg_amount) AS total_lg,
              COUNT(DISTINCT m.trade_date)::int AS days_covered
       FROM stock_moneyflow m
       JOIN stocks s ON m.ts_code = s.ts_code
       WHERE s.is_active = true AND s.industry IS NOT NULL AND s.industry != ''
         AND m.trade_date >= (SELECT MAX(trade_date) FROM stock_moneyflow) - $1::int + 1
         AND m.trade_date >= (
           SELECT trade_date FROM stock_moneyflow ORDER BY trade_date DESC LIMIT 1 OFFSET $1 - 1
         )
       GROUP BY s.industry
       HAVING COUNT(DISTINCT m.ts_code) >= 3
       ORDER BY total_net DESC NULLS LAST`,
      days
    );
    return Response.json({
      days,
      sectors: rows.map((r) => ({
        industry: r.industry,
        stockCount: r.stock_count,
        totalNet: r.total_net != null ? Number(r.total_net) : null,
        totalElg: r.total_elg != null ? Number(r.total_elg) : null,
        totalLg: r.total_lg != null ? Number(r.total_lg) : null,
      })),
    });
  } catch (e: any) {
    console.error("[api/market/sector-flow]", e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
