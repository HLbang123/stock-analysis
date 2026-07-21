/**
 * GET /api/scan — 全市场选股扫描
 *
 * 过滤器（AND 组合，各自可勾选）：
 *   - RPS：filterRps=true 时按 minRps + period 过滤
 *   - 5/13金叉：goldenCross=true 时按 gcDays 过滤（0=当前MA5>MA13状态；>0=最近gcDays日内上穿）
 *   - 55日线朝上：ma55Up=true 时 MA55(今) >= MA55(5交易日前)
 *
 * 参数：
 *   period    - RPS 周期（默认 250）
 *   minRps    - 最低 RPS（默认 87，仅 filterRps=true 时生效）
 *   filterRps - 是否启用 RPS 阈值过滤（默认 true）
 *   industry  - 申万行业筛选词（可选，不传=全市场）
 *   goldenCross - 是否启用金叉过滤（默认 false）
 *   gcDays    - 金叉窗口天数（1/3/5 或自定义正整数；0=不限=当前金叉状态）
 *   ma55Up    - 是否启用 55日线朝上过滤（默认 false）
 *   minRoe    - 最低 ROE（仅 filterRoe=true 时生效，默认 15）
 *   filterRoe - 是否启用 ROE 过滤（默认 false）
 *   limit     - 返回数量（默认 50，上限 200）
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const period = parseInt(searchParams.get("period") || "250");
  const minRps = parseFloat(searchParams.get("minRps") || "87");
  const filterRps = searchParams.get("filterRps") !== "false"; // 默认 true
  const industry = searchParams.get("industry");
  const goldenCross = searchParams.get("goldenCross") === "true";
  const gcDaysRaw = parseInt(searchParams.get("gcDays") || "5");
  const gcDays = Number.isFinite(gcDaysRaw) ? Math.max(0, gcDaysRaw) : 5;
  const ma55Up = searchParams.get("ma55Up") === "true";
  const filterRoe = searchParams.get("filterRoe") === "true";
  const minRoe = parseFloat(searchParams.get("minRoe") || "15");
  const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 200);

  if (![20, 60, 120, 250].includes(period)) {
    return Response.json({ error: "period 必须为 20 / 60 / 120 / 250" }, { status: 400 });
  }

  const rpsCol = `rps_${period}`;
  const retCol = `ret_${period}`;

  try {
    const { prisma } = await import("@/lib/db");

    const latestRps = await prisma.rpsScore.findFirst({
      orderBy: { calcDate: "desc" },
      select: { calcDate: true },
    });
    if (!latestRps) {
      return Response.json({ error: "暂无 RPS 数据" }, { status: 404 });
    }

    const latestBar = await prisma.dailyBar.findFirst({
      orderBy: { tradeDate: "desc" },
      select: { tradeDate: true },
    });

    // startDate = 今天往前 120 日历日（覆盖 55 交易日 + 5 日斜率窗口 + 缓冲）
    const start = new Date();
    start.setDate(start.getDate() - 120);
    const startDate = start.toISOString().slice(0, 10).replace(/-/g, "");

    // 动态 WHERE 拼接
    const params: any[] = [latestRps.calcDate, startDate];
    const where: string[] = [`s.is_active = true`];

    if (filterRps) {
      params.push(minRps);
      where.push(`r.${rpsCol} >= $${params.length}`);
    }
    if (industry) {
      params.push(`%${industry}%`);
      where.push(`s.industry LIKE $${params.length}`);
    }
    if (goldenCross) {
      if (gcDays === 0) {
        // 不限：当前 MA5>MA13（金叉状态）
        where.push(`sig.gc_state = true`);
      } else {
        // 近 N 日内上穿过 且 当前仍 MA5>MA13（排除金叉后立即反转的伪信号）
        where.push(`sig.gc_fresh = true AND sig.gc_state = true`);
      }
    }
    if (ma55Up) {
      where.push(`sig.ma55_up = true`);
    }
    if (filterRoe) {
      params.push(minRoe);
      where.push(`f.roe >= $${params.length}`);
    }
    params.push(limit);

    // gcDays 作为 SQL 参数传入 sig CTE 的 BOOL_OR（金叉窗口）
    const gcParam = gcDays > 0 ? gcDays : 9999; // 0(不限)时 gc_fresh 不用，给个大值无害

    const query = `
      WITH recent AS (
        SELECT "tsCode", "tradeDate", close,
          AVG(close) OVER w5  AS ma5,
          AVG(close) OVER w13 AS ma13,
          AVG(close) OVER w55 AS ma55,
          ROW_NUMBER() OVER (PARTITION BY "tsCode" ORDER BY "tradeDate" DESC) AS rn
        FROM daily_bars
        WHERE "tradeDate" >= $2
          AND "tsCode" IN (SELECT ts_code FROM stocks WHERE is_active = true)
        WINDOW
          w5  AS (PARTITION BY "tsCode" ORDER BY "tradeDate" ROWS BETWEEN 4 PRECEDING AND CURRENT ROW),
          w13 AS (PARTITION BY "tsCode" ORDER BY "tradeDate" ROWS BETWEEN 12 PRECEDING AND CURRENT ROW),
          w55 AS (PARTITION BY "tsCode" ORDER BY "tradeDate" ROWS BETWEEN 54 PRECEDING AND CURRENT ROW)
      ),
      mas AS (
        SELECT "tsCode", rn, ma5, ma13, ma55, "tradeDate",
          LAG(ma5)  OVER (PARTITION BY "tsCode" ORDER BY "tradeDate") AS ma5_prev,
          LAG(ma13) OVER (PARTITION BY "tsCode" ORDER BY "tradeDate") AS ma13_prev
        FROM recent
      ),
      sig AS (
        SELECT "tsCode",
          MAX(CASE WHEN rn = 1 THEN ma55 END) AS ma55_now,
          MAX(CASE WHEN rn = 1 THEN ma5  END) AS ma5_now,
          MAX(CASE WHEN rn = 1 THEN ma13 END) AS ma13_now,
          BOOL_OR(rn <= ${gcParam} AND ma5_prev <= ma13_prev AND ma5 > ma13) AS gc_fresh,
          BOOL_OR(rn = 1 AND ma5 > ma13) AS gc_state,
          (MAX(CASE WHEN rn = 1 THEN ma55 END) >= MAX(CASE WHEN rn = 6 THEN ma55 END)) AS ma55_up
        FROM mas GROUP BY "tsCode"
      )
      SELECT s.ts_code, s.name, s.industry,
             r.${rpsCol} AS rps, r.${retCol} AS ret,
             db.close AS latest_close, db.change_pct AS latest_change, db.vol AS latest_vol,
             sig.ma5_now, sig.ma13_now, sig.ma55_now,
             sig.gc_fresh, sig.gc_state, sig.ma55_up,
             f.roe AS roe
      FROM sig
      JOIN stocks s ON sig."tsCode" = s.ts_code
      JOIN rps_scores r ON r."tsCode" = sig."tsCode" AND r."calcDate" = $1
      LEFT JOIN stock_fundamentals f ON f.ts_code = sig."tsCode"
      LEFT JOIN LATERAL (
        SELECT close, change_pct, vol FROM daily_bars
        WHERE "tsCode" = sig."tsCode" AND "tradeDate" <= $1
        ORDER BY "tradeDate" DESC LIMIT 1
      ) db ON true
      WHERE ${where.join(" AND ")}
      ORDER BY r.${rpsCol} DESC NULLS LAST
      LIMIT $${params.length}
    `;

    interface ScanRow {
      ts_code: string;
      name: string;
      industry: string | null;
      rps: number | null;
      ret: number | null;
      latest_close: number | null;
      latest_change: number | null;
      latest_vol: number | null;
      ma5_now: number | null;
      ma13_now: number | null;
      ma55_now: number | null;
      gc_fresh: boolean | null;
      gc_state: boolean | null;
      ma55_up: boolean | null;
      roe: number | null;
    }

    const rows = await prisma.$queryRawUnsafe<any[]>(query, ...params);

    return Response.json({
      calcDate: latestRps.calcDate,
      barDate: latestBar?.tradeDate,
      period,
      count: rows.length,
      items: rows.map((r: ScanRow) => ({
        tsCode: r.ts_code,
        name: r.name,
        industry: r.industry,
        rps: r.rps != null ? Number(r.rps) : null,
        ret: r.ret != null ? Number(r.ret) : null,
        latestClose: r.latest_close != null ? Number(r.latest_close) : null,
        latestChange: r.latest_change != null ? Number(r.latest_change) : null,
        latestVol: r.latest_vol != null ? Number(r.latest_vol) : null,
        ma5: r.ma5_now != null ? Number(r.ma5_now) : null,
        ma13: r.ma13_now != null ? Number(r.ma13_now) : null,
        ma55: r.ma55_now != null ? Number(r.ma55_now) : null,
        gcFresh: r.gc_fresh === true,
        gcState: r.gc_state === true,
        ma55Up: r.ma55_up === true,
        roe: r.roe != null ? Number(r.roe) : null,
      })),
    });
  } catch (e: any) {
    console.error("[api/scan]", e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
