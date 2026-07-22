/** GET /api/fuyao/limit-up — 涨停股票池 + 连板天梯合并返回 */
export async function GET() {
  try {
    const { fuyaoGet } = await import("@/lib/fuyao");
    const [pool, ladder] = await Promise.all([
      fuyaoGet("/api/a-share/special-data/limit-up-pool"),
      fuyaoGet("/api/a-share/special-data/limit-up-ladder"),
    ]);
    return Response.json({ pool, ladder });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
