/**
 * GET /api/market/index-valuation?ts_code=000001.SH
 * 返回 { tsCode, name, currentPe, currentPb, percentile, history:[{date,pe}] }
 * percentile = 历史 pe_ttm 低于当前的比例(%)
 */
const IDX_NAMES: Record<string, string> = {
  "000001.SH": "上证综指", "399001.SZ": "深证成指", "399006.SZ": "创业板指",
  "000016.SH": "上证50", "000905.SH": "中证500", "000300.SH": "沪深300",
};

export async function GET(request: Request) {
  const tsCode = new URL(request.url).searchParams.get("ts_code") || "000001.SH";
  try {
    const { prisma } = await import("@/lib/db");

    const cur: any[] = await prisma.$queryRawUnsafe(
      `SELECT pe, pe_ttm, pb, turnover_rate FROM index_valuation
       WHERE ts_code = $1 ORDER BY trade_date DESC LIMIT 1`,
      tsCode
    );
    if (cur.length === 0) return Response.json({ error: "无该指数估值数据" }, { status: 404 });
    const currentPeTtm = cur[0].pe_ttm;

    const pct: any[] = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE pe_ttm < $2)::int AS below
       FROM index_valuation WHERE ts_code = $1 AND pe_ttm IS NOT NULL`,
      tsCode, currentPeTtm
    );
    const total = Number(pct[0]?.total ?? 0);
    const below = Number(pct[0]?.below ?? 0);
    const percentile = total > 0 ? Number(((below / total) * 100).toFixed(1)) : null;

    const hist: any[] = await prisma.$queryRawUnsafe(
      `SELECT trade_date, pe_ttm FROM index_valuation
       WHERE ts_code = $1 ORDER BY trade_date DESC LIMIT 250`,
      tsCode
    );

    return Response.json({
      tsCode,
      name: IDX_NAMES[tsCode] || tsCode,
      currentPe: cur[0].pe != null ? Number(cur[0].pe) : null,
      currentPeTtm: currentPeTtm != null ? Number(currentPeTtm) : null,
      currentPb: cur[0].pb != null ? Number(cur[0].pb) : null,
      percentile,
      history: hist.map((r) => ({ date: r.trade_date, pe: r.pe_ttm != null ? Number(r.pe_ttm) : null })).reverse(),
    });
  } catch (e: any) {
    console.error("[api/market/index-valuation]", e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
