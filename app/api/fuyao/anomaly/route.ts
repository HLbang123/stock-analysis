/** GET /api/fuyao/anomaly?tags=LIMIT_UP,LIMIT_DOWN 或 ?code=600519.SH */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const tags = searchParams.get("tags");
  const code = searchParams.get("code");
  try {
    const { fuyaoGet } = await import("@/lib/fuyao");
    let data: any;
    if (code) {
      data = await fuyaoGet("/api/a-share/special-data/anomaly-analysis-stock", { thscodes: code });
    } else {
      data = await fuyaoGet("/api/a-share/special-data/anomaly-analysis-list", tags ? { tag_codes: tags } : undefined);
    }
    return Response.json(data);
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
