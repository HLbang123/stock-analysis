/** GET /api/industries — 申万一级行业及股票数 + 其下二级子行业
 *  L2→L1 父子关系用成分股重叠推导：L2 的成分股属于哪个 L1，即其父级
 *  （每只股票 L1/L2 各唯一，故 MAX(l1) 即父级）。前端用于 L1 下小字提示 + 选中后展开 L2 子目录。
 */
export async function GET() {
  try {
    const { prisma } = await import("@/lib/db");
    // L1 列表 + 股票数
    const l1Rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT m.index_name AS name, COUNT(DISTINCT m.member_code)::int AS count
       FROM sw_index_member m
       JOIN stocks s ON m.member_code = s.ts_code
       WHERE m.index_level = 'L1' AND s.is_active = true
         AND m.index_name IS NOT NULL
       GROUP BY m.index_name
       ORDER BY count DESC`
    );
    // L2 → L1 父级映射（成分股重叠，MAX 取父级）
    const l2Rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT l2.index_name AS l2, MAX(l1.index_name) AS l1
       FROM sw_index_member l2
       JOIN sw_index_member l1
         ON l1.member_code = l2.member_code AND l1.index_level = 'L1'
       WHERE l2.index_level = 'L2' AND l2.index_name IS NOT NULL
       GROUP BY l2.index_name`
    );
    const l2byL1: Record<string, string[]> = {};
    for (const r of l2Rows) {
      if (!r.l1) continue;
      (l2byL1[r.l1] ||= []).push(r.l2);
    }
    return Response.json({
      industries: l1Rows.map((r) => ({
        name: r.name,
        count: r.count,
        l2: (l2byL1[r.name] || []).sort(),
      })),
    });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
