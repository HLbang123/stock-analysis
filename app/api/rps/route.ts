/**
 * GET /api/rps — RPS 排名查询
 *
 * 参数：
 *   period   - RPS 周期: 20 | 60 | 120 | 250（默认 250）
 *   min      - 最低 RPS 分数: 0-100（默认 87）
 *   limit    - 返回数量（默认 50，最大 200）
 *   industry - 申万行业筛选（可选，如 "半导体"）
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const period = parseInt(searchParams.get("period") || "250");
  const minRps = parseFloat(searchParams.get("min") || "87");
  const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 200);
  const industry = searchParams.get("industry");

  if (![20, 60, 120, 250].includes(period)) {
    return Response.json(
      { error: "period 必须为 20 / 60 / 120 / 250" },
      { status: 400 }
    );
  }

  const col = `rps_${period}`;
  const retCol = `ret_${period}`;

  try {
    const { prisma } = await import("@/lib/db");

    const latest = await prisma.rpsScore.findFirst({
      orderBy: { calcDate: "desc" },
      select: { calcDate: true },
    });

    if (!latest) {
      return Response.json({ error: "暂无 RPS 数据，请先运行 compute-rps" }, { status: 404 });
    }

    const calcDate = latest.calcDate;

    const params: any[] = [calcDate, minRps];
    let whereClause = `WHERE r."calcDate" = $1 AND r.${col} >= $2`;

    if (industry) {
      whereClause += ` AND s.industry LIKE $${params.length + 1}`;
      params.push(`%${industry}%`);
    }

    params.push(limit);

    const query = `
      SELECT s."ts_code", s.name, s.industry, r.${col} as rps, r.${retCol} as ret
      FROM rps_scores r
      JOIN stocks s ON r."tsCode" = s."ts_code"
      ${whereClause}
      ORDER BY r.${col} DESC
      LIMIT $${params.length}
    `;

    const rows = await prisma.$queryRawUnsafe<Array<{
      ts_code: string;
      name: string;
      industry: string;
      rps: number;
      ret: number;
    }>>(query, ...params);

    return Response.json({
      calcDate,
      period,
      count: rows.length,
      items: rows.map((r) => ({
        tsCode: r.ts_code,
        name: r.name,
        industry: r.industry,
        rps: Number(r.rps),
        ret: Number(r.ret),
      })),
    });
  } catch (e: any) {
    console.error("[api/rps]", e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
