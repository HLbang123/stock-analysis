/** GET /api/fuyao/hot-stocks?level=24h — 热股榜单 + 飙升榜 */
export async function GET(request: Request) {
  const level = (new URL(request.url).searchParams.get("level") || "24h") as "24h" | "1h";
  try {
    const { getHotStockList, getSkyrocketList } = await import("@/lib/fuyao");
    const [hot, skyrocket] = await Promise.all([
      getHotStockList(level),
      getSkyrocketList("hour"),
    ]);
    return Response.json({ hot, skyrocket });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
