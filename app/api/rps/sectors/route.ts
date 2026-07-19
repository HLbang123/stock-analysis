/**
 * GET /api/rps/sectors — 行业板块 RPS 强度
 *
 * 参数：
 *   period - RPS 周期（默认 250）
 *   min    - 高 RPS 阈值（默认 87）
 *
 * 返回各申万行业中 RPS ≥ min 的股票占比（%）
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const period = parseInt(searchParams.get("period") || "250");
  const minRps = parseFloat(searchParams.get("min") || "87");

  if (![20, 60, 120, 250].includes(period)) {
    return Response.json({ error: "period 必须为 20 / 60 / 120 / 250" }, { status: 400 });
  }

  const col = `rps_${period}`;

  try {
    const { prisma } = await import("@/lib/db");

    const latest = await prisma.rpsScore.findFirst({
      orderBy: { calcDate: "desc" },
      select: { calcDate: true },
    });
    if (!latest) {
      return Response.json({ error: "暂无 RPS 数据" }, { status: 404 });
    }

    const rows = await prisma.$queryRawUnsafe<Array<{
      industry: string;
      total: number;
      strong: number;
      avg_rps: number;
    }>>(
      `SELECT
        s.industry,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE r.${col} >= $2)::int AS strong,
        ROUND(AVG(r.${col})::numeric, 1) AS avg_rps
      FROM rps_scores r
      JOIN stocks s ON r."tsCode" = s."ts_code"
      WHERE r."calcDate" = $1
        AND s.industry IS NOT NULL
        AND s.industry != ''
        AND s.is_active = true
      GROUP BY s.industry
      HAVING COUNT(*) >= 5
      ORDER BY strong DESC, avg_rps DESC`,
      latest.calcDate,
      minRps
    );

    return Response.json({
      calcDate: latest.calcDate,
      period,
      minRps,
      sectors: rows.map((r) => ({
        industry: r.industry,
        total: r.total,
        strong: r.strong,
        ratio: Math.round((r.strong / r.total) * 100),
        avgRps: Number(r.avg_rps),
      })),
    });
  } catch (e: any) {
    console.error("[api/rps/sectors]", e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
