/**
 * GET /api/market/sector-flow?days=5 — 板块资金流向（同花顺 THS 行业口径，2026-08 起）
 * 返回近 N 个交易日各行业的资金净额（亿元），按净额降序
 */
export async function GET(request: Request) {
  const days = Math.min(parseInt(new URL(request.url).searchParams.get("days") || "5"), 30);
  try {
    const { prisma } = await import("@/lib/db");
    // 最近 N 个交易日（industry_moneyflow_ths 按日全行业）
    const dayRows: any[] = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT trade_date FROM industry_moneyflow_ths ORDER BY trade_date DESC LIMIT $1`,
      days
    );
    if (dayRows.length === 0) return Response.json({ days, sectors: [] });
    const dates = dayRows.map((r: any) => r.trade_date);

    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT industry,
              SUM(net_amount) AS total_net,
              AVG(pct_change) AS avg_pct,
              COUNT(DISTINCT trade_date)::int AS days_covered,
              MAX(lead_stock) AS lead_stock,
              MAX(company_num)::int AS company_num
       FROM industry_moneyflow_ths
       WHERE trade_date = ANY($1::varchar[])
       GROUP BY industry
       ORDER BY total_net DESC NULLS LAST`,
      dates
    );
    return Response.json({
      days: dates.length,
      sectors: rows.map((r) => ({
        industry: r.industry,
        totalNet: r.total_net != null ? Number(r.total_net) : null,
        avgPct: r.avg_pct != null ? Number(r.avg_pct) : null,
        daysCovered: r.days_covered,
        leadStock: r.lead_stock,
        companyNum: r.company_num,
      })),
    });
  } catch (e: any) {
    console.error("[api/market/sector-flow]", e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
