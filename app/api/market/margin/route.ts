/** GET /api/market/margin?days=120 — 融资融券市场总量近 N 日（两交易所合计，老→新） */
export async function GET(request: Request) {
  const days = Math.min(parseInt(new URL(request.url).searchParams.get("days") || "120"), 500);
  try {
    const { prisma } = await import("@/lib/db");
    // 按 trade_date 聚合两交易所
    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT trade_date,
              SUM(rzye) AS rzye, SUM(rqye) AS rqye, SUM(rzmre) AS rzmre,
              SUM(rzche) AS rzche, SUM(rzrqye) AS rzrqye
       FROM margin_total GROUP BY trade_date ORDER BY trade_date DESC LIMIT $1`,
      days
    );
    const items = rows.map((r) => ({
      date: r.trade_date,
      rzye: r.rzye != null ? Number(r.rzye) : null,           // 融资余额(元)
      rqye: r.rqye != null ? Number(r.rqye) : null,           // 融券余额(元)
      rzrqye: r.rzrqye != null ? Number(r.rzrqye) : null,     // 融资融券余额(元)
      netChange: r.rzmre != null && r.rzche != null ? Number(r.rzmre) - Number(r.rzche) : null, // 融资净变化
    })).reverse();
    return Response.json({ count: items.length, items });
  } catch (e: any) {
    console.error("[api/market/margin]", e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
