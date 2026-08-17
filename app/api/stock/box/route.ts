/** GET /api/stock/box?code=sz002463 — 该股票最新吸筹箱体状态（stock_box 表，盘后预计算） */
export async function GET(request: Request) {
  const code = new URL(request.url).searchParams.get("code");
  if (!code) return Response.json({ error: "缺少 code" }, { status: 400 });

  // sz002463 → 002463.SZ
  const m = code.match(/^([a-z]+)(\d+)$/i);
  if (!m) return Response.json({ error: "无效代码" }, { status: 400 });
  const tsCode = `${m[2]}.${m[1].toUpperCase()}`;

  try {
    const { prisma } = await import("@/lib/db");
    const row = await prisma.stockBox.findFirst({
      where: { tsCode },
      orderBy: { tradeDate: "desc" },
    });
    if (!row) return Response.json({ row: null });
    return Response.json({
      row: {
        tradeDate: row.tradeDate,
        inBox: row.inBox,
        boxQuality: row.boxQuality,
        boxPos: row.boxPos,
        boxTop: row.boxTop,
        boxBottom: row.boxBottom,
        breakout: row.breakout,
      },
    });
  } catch (e: any) {
    console.error("[api/stock/box]", e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
