/**
 * GET /api/limit-up — 涨停情绪聚合
 *
 * 数据源优先级：
 *   1. 同花顺涨停池（fuyao limit-up-pool）：盘中实时，带涨停原因/封单/连板数
 *   2. Tushare limit_list_d：盘后明细（含跌停/炸板），当日无数据自动回溯最近有数据交易日
 */
export async function GET() {
  try {
    // ── 1. 同花顺涨停池（实时）──
    try {
      const { fuyaoGet } = await import("@/lib/fuyao");
      const pool = await fuyaoGet<{ timestamp: number; item: any[] }>("/api/a-share/special-data/limit-up-pool");
      if (pool?.item?.length) {
        return Response.json({
          source: "ths",
          tradeDate: null, // 实时数据
          count: { up: pool.item.length, down: null, broken: null }, // THS 无跌停/炸板维度
          items: {
            up: pool.item.map((r) => ({
              tsCode: r.thscode,
              name: r.name,
              close: r.last_price != null ? Number(r.last_price) : null,
              limitTimes: r.continue_day_cnt || 1,
              firstTime: r.limit_up_time || "",
              openTimes: 0,
              fdAmount: r.seal_money != null ? Number(r.seal_money) : null,
              upStat: r.limit_up_reason || "",
            })),
          },
        });
      }
    } catch { /* THS 失败/无数据 → 回退 Tushare */ }

    // ── 2. Tushare limit_list_d（盘后明细，当日无数据自动回溯）──
    const { prisma } = await import("@/lib/db");
    const latest: any[] = await prisma.$queryRawUnsafe(
      `SELECT "tradeDate" FROM daily_bars ORDER BY "tradeDate" DESC LIMIT 1`
    );
    if (!latest.length) return Response.json({ error: "无日线数据" }, { status: 404 });
    const tradeDate = latest[0].tradeDate;

    const { getLimitListD } = await import("@/lib/tushare");

    // limit_list_d 当天数据生成晚于日线主表：当日拉空时自动回溯最近有数据的交易日（最多 10 天）
    let rows: any[] = [];
    let useDate = tradeDate;
    for (let i = 0; i < 10 && rows.length === 0; i++) {
      rows = await getLimitListD(useDate);
      if (rows.length === 0) {
        const prev: any[] = await prisma.$queryRawUnsafe(
          `SELECT "tradeDate" FROM daily_bars WHERE "tradeDate" < $1 ORDER BY "tradeDate" DESC LIMIT 1`,
          useDate
        );
        if (!prev.length) break;
        useDate = prev[0].tradeDate;
      }
    }
    if (rows.length === 0) return Response.json({ error: "暂无涨跌停数据" }, { status: 404 });

    // 按类型分组（limit 字段：U涨停 / D跌停 / Z炸板）
    const up = rows.filter(r => r.limit === "U");
    const down = rows.filter(r => r.limit === "D");
    const broken = rows.filter(r => r.limit === "Z");

    return Response.json({
      source: "tushare",
      tradeDate: useDate,
      fallback: useDate !== tradeDate,
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
