/** GET /api/fuyao/hot-stocks?level=24h — 热股榜单 + 飙升榜 */
export async function GET(request: Request) {
  const level = new URL(request.url).searchParams.get("level") || "24h";
  try {
    const { fuyaoGet } = await import("@/lib/fuyao");
    const [hot, skyrocket] = await Promise.all([
      fuyaoGet("/api/a-share/special-data/hot-stock-list", { level }),
      fuyaoGet("/api/a-share/special-data/skyrocket-list", { level: "1h" }),
    ]);
    return Response.json({ hot, skyrocket });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
