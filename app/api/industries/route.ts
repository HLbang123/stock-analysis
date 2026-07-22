/** GET /api/industries — 申万一级行业及股票数（从 sw_index_member L1 聚合） */
export async function GET() {
  try {
    const { prisma } = await import("@/lib/db");
    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT m.index_name AS name, COUNT(DISTINCT m.member_code)::int AS count
       FROM sw_index_member m
       JOIN stocks s ON m.member_code = s.ts_code
       WHERE m.index_level = 'L1' AND s.is_active = true
         AND m.index_name IS NOT NULL
       GROUP BY m.index_name
       ORDER BY count DESC`
    );
    return Response.json({
      industries: rows.map((r) => ({ name: r.name, count: r.count })),
    });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
