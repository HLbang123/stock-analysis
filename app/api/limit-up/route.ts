/** GET /api/limit-up — 当日涨跌停数据（Tushare limit_list_d，替换 fuyao） */
export async function GET() {
  try {
    const { prisma } = await import("@/lib/db");
    // 取最新交易日
    const latest: any[] = await prisma.$queryRawUnsafe(
      `SELECT "tradeDate" FROM daily_bars ORDER BY "tradeDate" DESC LIMIT 1`
    );
    if (!latest.length) return Response.json({ error: "无日线数据" }, { status: 404 });
    const tradeDate = latest[0].tradeDate;

    const { getLimitListD } = await import("@/lib/tushare");
    const rows = await getLimitListD(tradeDate);

    // 按类型分组（limit 字段：U涨停 / D跌停 / Z炸板）
    const up = rows.filter(r => r.limit === "U");
    const down = rows.filter(r => r.limit === "D");
    const broken = rows.filter(r => r.limit === "Z");

    return Response.json({
      tradeDate,
      count: { up: up.length, down: down.length, broken: broken.length },
      items: {
        up: up.map(r => ({
          tsCode: r.ts_code, name: r.name, close: Number(r.close),
          pctChg: r.pct_chg != null ? Number(r.pct_chg) : null,
          limitTimes: r.limit_times || 1,
          firstTime: r.first_time, lastTime: r.last_time,
          openTimes: r.open_times || 0,
          fdAmount: r.fd_amount != null ? Number(r.fd_amount) : null,
          fcRatio: r.fc_ratio != null ? Number(r.fc_ratio) : null,
          upStat: r.up_stat || '',
        })),
        down: down.map(r => ({
          tsCode: r.ts_code, name: r.name, close: Number(r.close),
          pctChg: r.pct_chg != null ? Number(r.pct_chg) : null,
          limitTimes: r.limit_times || 1,
        })),
      },
    });
  } catch (e: any) {
    console.error("[api/limit-up]", e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
