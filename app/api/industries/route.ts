/** GET /api/industries — 获取所有申万行业及股票数（动态，从 stocks 表查） */
export async function GET() {
  try {
    const { prisma } = await import("@/lib/db");
    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT industry, COUNT(*)::int AS count
       FROM stocks
       WHERE is_active = true AND industry IS NOT NULL AND industry != ''
       GROUP BY industry
       ORDER BY count DESC`
    );
    return Response.json({
      industries: rows.map((r) => ({ name: r.industry, count: r.count })),
    });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
