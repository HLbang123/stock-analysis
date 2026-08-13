/** GET /api/fuyao/anomaly?tags=LIMIT_UP,LIMIT_DOWN 或 ?code=600519.SH */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const tags = searchParams.get("tags");
  const code = searchParams.get("code");
  try {
    const { getAnomalyByStock, getAnomalyList } = await import("@/lib/fuyao");
    const data = code ? await getAnomalyByStock(code) : await getAnomalyList(tags ?? undefined);
    return Response.json(data);
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
