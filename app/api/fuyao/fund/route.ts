/** GET /api/fuyao/fund?code=510050.SH — 基金基本资料 + 重仓股 */
export async function GET(request: Request) {
  const code = new URL(request.url).searchParams.get("code");
  if (!code) return Response.json({ error: "缺少 code" }, { status: 400 });
  // 判断 fund_type：SH/SZ 交易所 → exchange，OF → otc
  const fundType = code.endsWith(".OF") ? "otc" : "exchange";
  try {
    const { fuyaoGet } = await import("@/lib/fuyao");
    const [profile, holdings] = await Promise.all([
      fuyaoGet("/api/fund/profile/detail", { fund_type: fundType, thscode: code }).catch(() => null),
      fuyaoGet("/api/fund/portfolio/holdings", { fund_type: fundType, thscode: code }).catch(() => null),
    ]);
    return Response.json({ profile: profile?.item?.[0] || null, holdings: holdings?.item || [] });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
