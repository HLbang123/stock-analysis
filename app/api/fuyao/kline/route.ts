/**
 * GET /api/fuyao/kline — 同花顺历史日K（前复权，单票最长10年）
 *   ?code=600519 / 600519.SH / sh600519  标的（自动归一化为 thscode）
 *   ?days=250                            最近 N 个自然日窗口（默认250，最大 3650）
 *   &adjust=forward|none|backward        复权方式，默认 forward
 * 返回 bars: [{ date, open, high, low, close, volume(手), amount(元) }]（与 /api/kline 输出字段对齐，便于前端复用）
 * 用途：长窗口/回测级前复权序列（daily_bars 为 tushare 未复权raw，新浪/腾讯K线窗口短）
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const rawCode = (searchParams.get("code") || "").trim();
  const days = Math.min(parseInt(searchParams.get("days") || "250", 10) || 250, 3650);
  const adjust = searchParams.get("adjust") || "forward";
  if (!rawCode) return Response.json({ error: "缺少 code 参数" }, { status: 400 });
  if (!["none", "forward", "backward"].includes(adjust)) {
    return Response.json({ error: "adjust 仅支持 none/forward/backward" }, { status: 400 });
  }

  try {
    const { getHistoricalK, normalizeThscode } = await import("@/lib/fuyao");
    const thscode = normalizeThscode(rawCode);
    const end = Date.now();
    const start = end - days * 86400_000;
    const data = await getHistoricalK(thscode, start, end, adjust as "none" | "forward" | "backward");
    const bars = (data.item || []).map((b) => ({
      date: new Date(b.date_ms).toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" }),
      open: b.open_price,
      high: b.high_price,
      low: b.low_price,
      close: b.close_price,
      volume: Math.round(b.volume / 100), // 股 → 手，与新浪/腾讯K线口径一致
      amount: b.turnover,
    }));
    return Response.json({ code: thscode, adjust, count: bars.length, bars });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
