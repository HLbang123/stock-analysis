/** GET /api/market/northbound?days=120 — 北向资金近 N 日（日净流入+累计，老→新） */
export async function GET(request: Request) {
  const days = Math.min(parseInt(new URL(request.url).searchParams.get("days") || "120"), 500);
  try {
    const { prisma } = await import("@/lib/db");
    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT trade_date, north_money, hgt, sgt, north_total
       FROM northbound_flow ORDER BY trade_date DESC LIMIT $1`,
      days
    );
    const items = rows.map((r) => ({
      date: r.trade_date,
      northMoney: r.north_money != null ? Number(r.north_money) : null,
      hgt: r.hgt != null ? Number(r.hgt) : null,
      sgt: r.sgt != null ? Number(r.sgt) : null,
      northTotal: r.north_total != null ? Number(r.north_total) : null,
    })).reverse();
    return Response.json({ count: items.length, items });
  } catch (e: any) {
    console.error("[api/market/northbound]", e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
