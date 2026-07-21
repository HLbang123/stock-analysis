/** GET /api/stock/rps?code=sz002463 — 该股票最新 RPS */
export async function GET(request: Request) {
  const code = new URL(request.url).searchParams.get("code");
  if (!code) return Response.json({ error: "缺少 code" }, { status: 400 });

  // sz002463 → 002463.SZ
  const m = code.match(/^([a-z]+)(\d+)$/i);
  if (!m) return Response.json({ error: "无效代码" }, { status: 400 });
  const tsCode = `${m[2]}.${m[1].toUpperCase()}`;

  try {
    const { prisma } = await import("@/lib/db");
    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT rps_20, rps_60, rps_120, rps_250, ret_20, ret_60, ret_120, ret_250, "calcDate"
       FROM rps_scores WHERE "tsCode" = $1 ORDER BY "calcDate" DESC LIMIT 1`,
      tsCode
    );
    if (!rows || rows.length === 0) return Response.json({ error: "无 RPS 数据" }, { status: 404 });
    const r = rows[0];
    return Response.json({
      rps20: r.rps_20 != null ? Number(r.rps_20) : null,
      rps60: r.rps_60 != null ? Number(r.rps_60) : null,
      rps120: r.rps_120 != null ? Number(r.rps_120) : null,
      rps250: r.rps_250 != null ? Number(r.rps_250) : null,
      ret20: r.ret_20 != null ? Number(r.ret_20) : null,
      ret60: r.ret_60 != null ? Number(r.ret_60) : null,
      ret120: r.ret_120 != null ? Number(r.ret_120) : null,
      ret250: r.ret_250 != null ? Number(r.ret_250) : null,
      calcDate: r.calcDate,
    });
  } catch (e: any) {
    console.error("[api/stock/rps]", e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
