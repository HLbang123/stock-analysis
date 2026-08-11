/**
 * GET /api/scan — 全市场选股扫描
 *
 * 过滤器（AND 组合，各自可勾选）：
 *   - RPS：filterRps=true 时按 minRps 过滤。支持多周期共振（periods=20,60 → 每个周期都 ≥ minRps，AND）
 *   - 5/13金叉：goldenCross=true 时按窗口过滤，支持多选并集（gcDaysList=0,3 → 即将金叉 OR 近3日金叉）
 *   - 55日线朝上：ma55Up=true 时 MA55(今) >= MA55(5交易日前)
 *   - RSI：filterRsi=true 时启用。在 SQL 内用窗口函数算 SMA 近似 RSI(rsiPeriod)，
 *     rsiMin/rsiMax 任选其一或两者（AND 区间）。仅开启时计算，关闭零成本。
 *
 * 参数：
 *   periods   - RPS 周期多选，逗号分隔（20/60/120/250，AND 共振；缺省回退 legacy 单值 period，默认 250）
 *   period    - legacy 单周期（20/60/120/250，默认 250）；periods 存在时忽略
 *   minRps    - 最低 RPS（默认 87，仅 filterRps=true 时生效；多周期时每个周期都要求 ≥ minRps）
 *   filterRps - 是否启用 RPS 阈值过滤（默认 true）
 *   industry  - 申万行业筛选词（可选，不传=全市场）
 *   goldenCross - 是否启用金叉过滤（默认 false）
 *   gcDaysList - 金叉窗口多选，逗号分隔（0=即将金叉；正整数=最近N日内上穿，多值取并集）
 *   gcDays    - legacy 单窗口（0=即将金叉；>0=最近N日内上穿，默认 5）；gcDaysList 存在时忽略
 *   ma55Up    - 是否启用 55日线朝上过滤（默认 false）
 *   minRoe    - 最低 ROE（仅 filterRoe=true 时生效，默认 15）
 *   filterRoe - 是否启用 ROE 过滤（默认 false）
 *   filterRsi - 是否启用 RSI 过滤（默认 false）
 *   rsiPeriod - RSI 周期 6/12/24（默认 6，与预警 R07 同口径）
 *   rsiMin    - RSI 下限（可选，RSI ≥ 此值）
 *   rsiMax    - RSI 上限（可选，RSI ≤ 此值，如 30 筛超卖）
 *   board     - 板块过滤：all(默认)/main(主板)/gem(创业板)/star(科创板)/bjse(北交所)，按 ts_code 前缀
 *   filterMv  - 是否启用流通市值下限过滤（默认 false）
 *   minMv     - 流通市值下限（亿元，默认 100；仅 filterMv=true 时生效，取最新交易日 circ_mv）
 *   limit     - 返回数量（默认 50，上限 200）
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  // RPS 周期多选（AND 共振）；缺省回退 legacy 单值 period。主周期=最短周期（排序/兼容字段用它）
  const PERIOD_SET = [20, 60, 120, 250];
  const periodsRaw = searchParams.get("periods");
  let periods: number[] = periodsRaw != null
    ? [...new Set(periodsRaw.split(",").map(Number).filter((p) => PERIOD_SET.includes(p)))].sort((a, b) => a - b)
    : [];
  if (periods.length === 0) {
    const single = parseInt(searchParams.get("period") || "250");
    if (!PERIOD_SET.includes(single)) {
      return Response.json({ error: "period 必须为 20 / 60 / 120 / 250" }, { status: 400 });
    }
    periods = [single];
  }
  const primaryPeriod = periods[0];
  const minRps = parseFloat(searchParams.get("minRps") || "87");
  const filterRps = searchParams.get("filterRps") !== "false"; // 默认 true
  const industry = searchParams.get("industry");
  const industryLevel = searchParams.get("industryLevel") === "L2" ? "L2" : "L1";
  const goldenCross = searchParams.get("goldenCross") === "true";
  // 金叉窗口多选（OR 并集：0=即将金叉，正数=近N日上穿）；缺省回退 legacy 单值 gcDays
  const gcListRaw = searchParams.get("gcDaysList");
  let gcDaysList: number[] = gcListRaw != null
    ? [...new Set(gcListRaw.split(",").map(Number).filter((n) => Number.isFinite(n) && n >= 0).map((n) => Math.floor(n)))]
    : [];
  if (gcDaysList.length === 0) {
    const single = parseInt(searchParams.get("gcDays") || "5");
    gcDaysList = [Number.isFinite(single) ? Math.max(0, single) : 5];
  }
  const gcApproaching = gcDaysList.includes(0);
  // 多个正数窗口的 OR（近3日 ∨ 近5日）等价于最大窗口（近5日 ⊇ 近3日），SQL 只需算一个
  const gcMaxDays = Math.max(0, ...gcDaysList.filter((n) => n > 0));
  const ma55Up = searchParams.get("ma55Up") === "true";
  const filterRoe = searchParams.get("filterRoe") === "true";
  const minRoe = parseFloat(searchParams.get("minRoe") || "15");
  const filterRsi = searchParams.get("filterRsi") === "true";
  const rsiPeriodRaw = parseInt(searchParams.get("rsiPeriod") || "6");
  const rsiPeriod = [6, 12, 24].includes(rsiPeriodRaw) ? rsiPeriodRaw : 6;
  const rsiMin = searchParams.get("rsiMin");
  const rsiMax = searchParams.get("rsiMax");
  const board = searchParams.get("board") || "all";
  const filterMv = searchParams.get("filterMv") === "true";
  const minMvRaw = parseFloat(searchParams.get("minMv") || "100");
  const minMv = Number.isFinite(minMvRaw) ? Math.max(0, minMvRaw) : 100; // 流通市值下限（亿元）
  const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 200);

  // 主周期（最短选中周期）：排序列 + 兼容单值响应字段
  const rpsCol = `rps_${primaryPeriod}`;
  const retCol = `ret_${primaryPeriod}`;

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

    // startDate：120 日历日（覆盖 MA55 窗口）
    const start = new Date();
    start.setDate(start.getDate() - 120);
    const startDate = start.toISOString().slice(0, 10).replace(/-/g, "");

    // ---- 候选股预筛（非信号类硬过滤：RPS/行业/板块/ROE）----
    // 先剔除不满足硬条件的标的，再进重窗口函数 CTE，避免对全市场 ~5000 只算 MA/金叉信号。
    // 此前对全市场算完信号才过滤，过滤型查询（如 RPS+金叉）会很慢，用户长时间看到空白以为筛不出来。
    // 候选集 ⊇ 最终结果集（信号类过滤 gc/ma55/rsi 仍在最终 WHERE），故结果不变。
    const candParams: (string | number)[] = [];
    const candWhere: string[] = [`s.is_active = true`];
    if (filterRps) { for (const p of periods) { candParams.push(minRps); candWhere.push(`r.rps_${p} >= $${candParams.length}`); } }
    if (industry) { candParams.push(industry); candWhere.push(`s.ts_code IN (SELECT member_code FROM sw_index_member WHERE index_level = '${industryLevel}' AND index_name = $${candParams.length})`); }
    if (board === "main") candWhere.push(`s.ts_code ~ '^(600|601|603|605|000|001|002|003)'`);
    else if (board === "gem") candWhere.push(`s.ts_code ~ '^(300|301)'`);
    else if (board === "star") candWhere.push(`s.ts_code ~ '^(688|689)'`);
    else if (board === "bjse") candWhere.push(`s.ts_code ~ '\\.BJ$'`);
    if (filterRoe) { candParams.push(minRoe); candWhere.push(`f.roe >= $${candParams.length}`); }
    // 流通市值下限：取最新交易日的 circ_mv（万元），minMv 亿元换算为万元。NULL circ_mv 自动排除。
    if (filterMv && latestBar) {
      candParams.push(latestBar.tradeDate);
      const dateIdx = candParams.length;
      candParams.push(minMv * 10000);
      const mvIdx = candParams.length;
      candWhere.push(`s.ts_code IN (SELECT "tsCode" FROM daily_bars WHERE "tradeDate" = $${dateIdx} AND circ_mv >= $${mvIdx})`);
    }

    // 全局参数顺序：$1=calcDate, $2=startDate, $3..=candParams, 然后 rsi 参数, 最后 limit
    const params: any[] = [latestRps.calcDate, startDate, ...candParams];
    // cand CTE 内占位符需偏移 +2（前面已有 calcDate=$1、startDate=$2）
    const candWhereShifted = candWhere.map((w) => w.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + 2}`));
    const candCte = `cand AS (
        SELECT s.ts_code
        FROM stocks s
        JOIN rps_scores r ON r."tsCode" = s.ts_code AND r."calcDate" = $1
        LEFT JOIN stock_fundamentals f ON f.ts_code = s.ts_code
        WHERE ${candWhereShifted.join(" AND ")}
      )`;

    // 信号类过滤（依赖 CTE 算出的 gc/ma55/rsi），留在最终 WHERE
    const where: string[] = [];
    if (goldenCross) {
      const gcParts: string[] = [];
      if (gcApproaching) gcParts.push(`sig.gc_approaching = true`);
      if (gcMaxDays > 0) gcParts.push(`(sig.gc_fresh = true AND sig.gc_state = true)`);
      if (gcParts.length > 0) where.push(gcParts.length > 1 ? `(${gcParts.join(" OR ")})` : gcParts[0]);
    }
    if (ma55Up) where.push(`sig.ma55_up = true`);
    if (filterRsi) {
      const rsiExpr = `(CASE WHEN sig.rsi_al_now IS NULL OR sig.rsi_al_now = 0 THEN 100 ELSE 100 - 100 / (1 + sig.rsi_ag_now / sig.rsi_al_now) END)`;
      if (rsiMin != null && rsiMin !== "") { params.push(Number(rsiMin)); where.push(`${rsiExpr} >= $${params.length}`); }
      if (rsiMax != null && rsiMax !== "") { params.push(Number(rsiMax)); where.push(`${rsiExpr} <= $${params.length}`); }
    }
    params.push(limit);

    // gcMaxDays 作为 SQL 参数传入 sig CTE 的 BOOL_OR（金叉窗口）；无正数窗口时 gc_fresh 不用，给个大值无害
    const gcParam = gcMaxDays > 0 ? gcMaxDays : 9999;

    // ---- RSI 模式专属 SQL 片段（filterRsi=false 时全部为空字符串，查询退化为原样）----
    // SMA 近似 RSI：gain/loss 取 SMA(rsiPeriod)，rsi = 100 - 100/(1 + avgGain/avgLoss)
    const rsiRecentCols = filterRsi ? `,
          GREATEST(close - LAG(close) OVER (PARTITION BY "tsCode" ORDER BY "tradeDate"), 0) AS gain,
          GREATEST(LAG(close) OVER (PARTITION BY "tsCode" ORDER BY "tradeDate") - close, 0) AS loss` : "";
    const rsiMasCols = filterRsi ? `,
          AVG(gain) OVER (PARTITION BY "tsCode" ORDER BY "tradeDate" ROWS BETWEEN ${rsiPeriod - 1} PRECEDING AND CURRENT ROW) AS rsi_ag,
          AVG(loss) OVER (PARTITION BY "tsCode" ORDER BY "tradeDate" ROWS BETWEEN ${rsiPeriod - 1} PRECEDING AND CURRENT ROW) AS rsi_al` : "";
    const rsiSigCols = filterRsi ? `,
          MAX(CASE WHEN rn = 1 THEN rsi_ag END) AS rsi_ag_now,
          MAX(CASE WHEN rn = 1 THEN rsi_al END) AS rsi_al_now` : "";
    const rsiSelect = filterRsi
      ? `,
          CASE WHEN sig.rsi_al_now IS NULL OR sig.rsi_al_now = 0 THEN 100
               ELSE 100 - 100 / (1 + sig.rsi_ag_now / sig.rsi_al_now) END AS rsi`
      : "";

    // 每个选中周期输出一列 RPS/收益（前端分行展示；响应再补主周期单值字段做兼容）
    const rpsColsSelect = periods.map((p) => `r.rps_${p} AS rps_${p}, r.ret_${p} AS ret_${p}`).join(", ");

    const query = `
      WITH ${candCte},
      recent AS (
        SELECT "tsCode", "tradeDate", close,
          AVG(close) OVER w5  AS ma5,
          AVG(close) OVER w13 AS ma13,
          AVG(close) OVER w55 AS ma55${rsiRecentCols},
          ROW_NUMBER() OVER (PARTITION BY "tsCode" ORDER BY "tradeDate" DESC) AS rn
        FROM (
          -- 前复权口径：close × adj_factor / 窗口内最新因子。除权日的假跳空会让 MA/金叉/RSI 失真；
          -- 归一到最新因子后，窗口末根前复权价 == 原始价，展示口径(latest_close 原始价)与 MA 同尺度。
          -- adj_factor 缺失(回补未完成)时 COALESCE 退化为原始价，与旧行为一致
          SELECT "tsCode", "tradeDate",
                 close * COALESCE(adj_factor, 1)
                   / FIRST_VALUE(COALESCE(adj_factor, 1)) OVER (PARTITION BY "tsCode" ORDER BY "tradeDate" DESC) AS close
          FROM daily_bars
          WHERE "tradeDate" >= $2
            AND "tsCode" IN (SELECT ts_code FROM cand)
        ) qfq
        WINDOW
          w5  AS (PARTITION BY "tsCode" ORDER BY "tradeDate" ROWS BETWEEN 4 PRECEDING AND CURRENT ROW),
          w13 AS (PARTITION BY "tsCode" ORDER BY "tradeDate" ROWS BETWEEN 12 PRECEDING AND CURRENT ROW),
          w55 AS (PARTITION BY "tsCode" ORDER BY "tradeDate" ROWS BETWEEN 54 PRECEDING AND CURRENT ROW)
      ),
      mas AS (
        SELECT "tsCode", rn, ma5, ma13, ma55, "tradeDate", close,
          LAG(ma5)  OVER (PARTITION BY "tsCode" ORDER BY "tradeDate") AS ma5_prev,
          LAG(ma13) OVER (PARTITION BY "tsCode" ORDER BY "tradeDate") AS ma13_prev${rsiMasCols}
        FROM recent
      ),
      sig AS (
        SELECT "tsCode",
          MAX(CASE WHEN rn = 1 THEN ma55 END) AS ma55_now,
          MAX(CASE WHEN rn = 1 THEN ma5  END) AS ma5_now,
          MAX(CASE WHEN rn = 1 THEN ma13 END) AS ma13_now,
          MAX(CASE WHEN rn = 2 THEN ma5  END) AS ma5_prev_now,
          MAX(CASE WHEN rn = 1 THEN close END) AS latest_close_ma,
          BOOL_OR(rn <= ${gcParam} AND ma5_prev <= ma13_prev AND ma5 > ma13) AS gc_fresh,
          BOOL_OR(rn = 1 AND ma5 > ma13) AS gc_state,
          -- 即将金叉：MA5<MA13（未金叉）+ 差距<2% + MA5在涨
          (MAX(CASE WHEN rn = 1 THEN ma5 END) < MAX(CASE WHEN rn = 1 THEN ma13 END)
           AND (MAX(CASE WHEN rn = 1 THEN ma13 END) - MAX(CASE WHEN rn = 1 THEN ma5 END)) / NULLIF(MAX(CASE WHEN rn = 1 THEN ma13 END), 0) < 0.02
           AND MAX(CASE WHEN rn = 1 THEN ma5 END) > MAX(CASE WHEN rn = 2 THEN ma5 END)) AS gc_approaching,
          -- 55日线朝上：最新价 > 最新MA55
          (MAX(CASE WHEN rn = 1 THEN close END) > MAX(CASE WHEN rn = 1 THEN ma55 END)) AS ma55_up${rsiSigCols}
        FROM mas GROUP BY "tsCode"
      )
      SELECT s.ts_code, s.name, s.industry,
             ${rpsColsSelect},
             db.close AS latest_close, db.change_pct AS latest_change, db.vol AS latest_vol,
             sig.ma5_now, sig.ma13_now, sig.ma55_now,
             sig.gc_fresh, sig.gc_state, sig.gc_approaching,
             sig.ma55_up,
             f.roe AS roe${rsiSelect}
      FROM sig
      JOIN stocks s ON sig."tsCode" = s.ts_code
      JOIN rps_scores r ON r."tsCode" = sig."tsCode" AND r."calcDate" = $1
      LEFT JOIN stock_fundamentals f ON f.ts_code = sig."tsCode"
      LEFT JOIN LATERAL (
        SELECT close, change_pct, vol FROM daily_bars
        WHERE "tsCode" = sig."tsCode" AND "tradeDate" <= $1
        ORDER BY "tradeDate" DESC LIMIT 1
      ) db ON true
      WHERE ${where.length ? where.join(" AND ") : "true"}
      ORDER BY r.${rpsCol} DESC NULLS LAST
      LIMIT $${params.length}
    `;

    const rows = await prisma.$queryRawUnsafe<any[]>(query, ...params);

    return Response.json({
      calcDate: latestRps.calcDate,
      barDate: latestBar?.tradeDate,
      period: primaryPeriod, // 兼容字段：主周期（最短选中周期）
      periods,
      count: rows.length,
      items: rows.map((r: any) => ({
        tsCode: r.ts_code,
        name: r.name,
        industry: r.industry,
        rpsList: periods.map((p) => ({ period: p, rps: r[`rps_${p}`] != null ? Number(r[`rps_${p}`]) : null })),
        rps: r[`rps_${primaryPeriod}`] != null ? Number(r[`rps_${primaryPeriod}`]) : null,
        ret: r[`ret_${primaryPeriod}`] != null ? Number(r[`ret_${primaryPeriod}`]) : null,
        latestClose: r.latest_close != null ? Number(r.latest_close) : null,
        latestChange: r.latest_change != null ? Number(r.latest_change) : null,
        latestVol: r.latest_vol != null ? Number(r.latest_vol) : null,
        ma5: r.ma5_now != null ? Number(r.ma5_now) : null,
        ma13: r.ma13_now != null ? Number(r.ma13_now) : null,
        ma55: r.ma55_now != null ? Number(r.ma55_now) : null,
        gcFresh: r.gc_fresh === true,
        gcState: r.gc_state === true,
        gcApproaching: r.gc_approaching === true,
        ma55Up: r.ma55_up === true,
        roe: r.roe != null ? Number(r.roe) : null,
        rsi: r.rsi != null ? Number(r.rsi) : null,
      })),
    });
  } catch (e: any) {
    console.error("[api/scan]", e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
