/**
 * GET /api/scan — 综合扫描：RPS + 申万行业 + 涨跌幅
 *
 * 参数：
 *   period    - RPS 周期（默认 250）
 *   minRps    - 最低 RPS（默认 85）
 *   industry  - 申万行业（可选，如 "半导体"）
 *   limit     - 返回数量（默认 30）
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const period = parseInt(searchParams.get("period") || "250");
  const minRps = parseFloat(searchParams.get("minRps") || "85");
  const industry = searchParams.get("industry");
  const limit = Math.min(parseInt(searchParams.get("limit") || "30"), 100);

  if (![20, 60, 120, 250].includes(period)) {
    return Response.json({ error: "period 必须为 20 / 60 / 120 / 250" }, { status: 400 });
  }

  const rpsCol = `rps_${period}`;
  const retCol = `ret_${period}`;

  try {
    const { prisma } = await import("@/lib/db");

    const latestRps = await prisma.rpsScore.findFirst({
      orderBy: { calcDate: "desc" },
      select: { calcDate: true },
    });
    if (!latestRps) {
      return Response.json({ error: "暂无 RPS 数据" }, { status: 404 });
    }

    const latestBar = await prisma.dailyBar.findFirst({
      orderBy: { tradeDate: "desc" },
      select: { tradeDate: true },
    });

    const params: any[] = [latestRps.calcDate, minRps];
    let whereClause = `WHERE r."calcDate" = $1 AND r.${rpsCol} >= $2 AND s.is_active = true`;

    if (industry) {
      whereClause += ` AND s.industry LIKE $${params.length + 1}`;
      params.push(`%${industry}%`);
    }

    params.push(limit);

    const query = `
      SELECT DISTINCT
        s."ts_code",
        s.name,
        s.industry,
        r.${rpsCol} AS rps,
        r.${retCol} AS ret,
        db.close AS latest_close,
        db.change_pct AS latest_change,
        db.vol AS latest_vol
      FROM rps_scores r
      JOIN stocks s ON r."tsCode" = s."ts_code"
      LEFT JOIN LATERAL (
        SELECT close, change_pct, vol
        FROM daily_bars
        WHERE "tsCode" = r."tsCode" AND "tradeDate" <= $1
        ORDER BY "tradeDate" DESC
        LIMIT 1
      ) db ON true
      ${whereClause}
      ORDER BY r.${rpsCol} DESC
      LIMIT $${params.length}
    `;

    const rows = await prisma.$queryRawUnsafe<Array<{
      ts_code: string;
      name: string;
      industry: string;
      rps: number;
      ret: number;
      latest_close: number;
      latest_change: number;
      latest_vol: number;
    }>>(query, ...params);

    return Response.json({
      calcDate: latestRps.calcDate,
      barDate: latestBar?.tradeDate,
      period,
      count: rows.length,
      items: rows.map((r) => ({
        tsCode: r.ts_code,
        name: r.name,
        industry: r.industry,
        rps: Number(r.rps),
        ret: Number(r.ret),
        latestClose: Number(r.latest_close),
        latestChange: Number(r.latest_change),
        latestVol: Number(r.latest_vol),
      })),
    });
  } catch (e: any) {
    console.error("[api/scan]", e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
