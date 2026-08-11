/**
 * GET /api/ths/concepts?code=600519 / 600519.SH / sh600519 — 个股所属同花顺概念/行业反查
 * 数据来自 ths_index_member（sync-ths-index 每日盘后刷），返回当前成分快照。
 * 返回 { industries: string[], concepts: string[] }（概念按名称排序，数量多时前端截断展示）
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const rawCode = (searchParams.get("code") || "").trim();
  if (!rawCode) return Response.json({ error: "缺少 code 参数" }, { status: 400 });

  // 归一化为 thscode
  let thscode: string;
  if (/^\d{6}$/.test(rawCode)) {
    thscode = `${rawCode}.${rawCode.startsWith("6") ? "SH" : rawCode.startsWith("4") || rawCode.startsWith("8") ? "BJ" : "SZ"}`;
  } else if (/^[a-z]{2}\d{6}$/i.test(rawCode)) {
    thscode = `${rawCode.slice(2)}.${rawCode.slice(0, 2).toUpperCase()}`;
  } else {
    thscode = rawCode.toUpperCase();
  }

  try {
    const { prisma } = await import("@/lib/db");
    const rows: { name: string; tag: string }[] = await prisma.$queryRawUnsafe(
      `SELECT i.name, i.tag
       FROM ths_index_member m JOIN ths_index i ON i.thscode = m.thscode
       WHERE m.ts_code = $1
       ORDER BY i.tag, i.name`,
      thscode
    );
    return Response.json({
      code: thscode,
      industries: rows.filter((r) => r.tag === "industry").map((r) => r.name),
      concepts: rows.filter((r) => r.tag === "cn_concept").map((r) => r.name),
    });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
