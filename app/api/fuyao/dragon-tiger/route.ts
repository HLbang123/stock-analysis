/**
 * GET /api/fuyao/dragon-tiger — 龙虎榜榜单（同花顺，比 tushare top_list 多机构/游资席位拆分）
 *   ?board=all|org|hot_money  榜单类型，默认 all（org=机构榜，hot_money=游资榜）
 *   ?date=yyyy-MM-dd          交易日，缺省最近交易日（只支持一年内）
 *   ?code=002407.SZ           可选，按个股过滤（hot_money 榜过滤各游资的 rows）
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const board = (searchParams.get("board") || "all") as "all" | "org" | "hot_money";
  const date = searchParams.get("date") || undefined;
  // 代码归一化为 thscode：支持 6 位纯数字(600519→600519.SH)、sina 格式(sh600519)、thscode 原样
  const rawCode = searchParams.get("code")?.trim() || "";
  if (!["all", "org", "hot_money"].includes(board)) {
    return Response.json({ error: "board 仅支持 all/org/hot_money" }, { status: 400 });
  }
  try {
    const { getDragonTigerList, normalizeThscode } = await import("@/lib/fuyao");
    const code = rawCode ? normalizeThscode(rawCode) : undefined;
    const data = await getDragonTigerList(board, date);
    if (code) {
      // 个股过滤：all/org 过滤 stock_items；hot_money 过滤每个游资的 rows 并剔除空游资
      if (data.board_type === "hot_money") {
        data.hot_money_items = (data.hot_money_items || [])
          .map((h) => ({ ...h, rows: (h.rows || []).filter((r) => r.thscode === code) }))
          .filter((h) => h.rows.length > 0);
        data.stock_items = [];
      } else {
        data.stock_items = (data.stock_items || []).filter((s) => s.thscode === code);
        data.hot_money_items = [];
      }
    }
    return Response.json(data);
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
