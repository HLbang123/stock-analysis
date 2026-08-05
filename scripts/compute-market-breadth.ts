/**
 * 市场宽度 + 占比 预计算（每日，由 run-daily 调用）
 *
 * 从 daily_bars 聚合：涨跌家数 / 涨跌停 / 20日新高新低 / MA55 上方占比
 * 从 rps_scores 聚合：RPS60 改善占比（今日 rps_60 高于 5 交易日前 = 趋势改善广度）
 *   —— 注：RPS≥87 占比已被证伪移除（RPS 是百分位排名，占比恒 ≈13% 无信息量），2026-08-05
 * 结果 upsert 到 market_breadth（一行/交易日）
 *
 * 运行：npx tsx scripts/compute-market-breadth.ts [--init]
 *   --init 回补近 60 个交易日
 */

import { prisma } from "../lib/db";

/** 本地时区格式化 YYYYMMDD（不用 toISOString，避免 UTC+8 推前一天） */
function fmtDate(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

interface BreadthRow {
  advance: number | null;
  decline: number | null;
  flat: number | null;
  limitUp: number | null;
  limitDown: number | null;
  newHigh20: number | null;
  newLow20: number | null;
  aboveMa55Count: number | null;
  aboveMa55Ratio: number | null;
  rpsImproveRatio: number | null;
}

async function computeForDate(tradeDate: string): Promise<BreadthRow> {
  // 窗口起点：该交易日往前 90 日历日（覆盖 55 交易日 + 缓冲），必须相对 tradeDate 算
  const td = new Date(
    parseInt(tradeDate.slice(0, 4)),
    parseInt(tradeDate.slice(4, 6)) - 1,
    parseInt(tradeDate.slice(6, 8))
  );
  td.setDate(td.getDate() - 90);
  const startDate = fmtDate(td);

  // 1. 涨跌 / 涨跌停
  const cnt: any[] = await prisma.$queryRawUnsafe(
    `SELECT
       COUNT(*) FILTER (WHERE change_pct > 0)::int AS advance,
       COUNT(*) FILTER (WHERE change_pct < 0)::int AS decline,
       COUNT(*) FILTER (WHERE change_pct = 0)::int AS flat,
       COUNT(*) FILTER (WHERE change_pct >= 9.5)::int AS limit_up,
       COUNT(*) FILTER (WHERE change_pct <= -9.5)::int AS limit_down
     FROM daily_bars WHERE "tradeDate" = $1`,
    tradeDate
  );
  const c = cnt[0] ?? {};

  // 2. 20日新高新低 + MA55 上方（一次窗口查询）
  const win: any[] = await prisma.$queryRawUnsafe(
    `WITH ranked AS (
       SELECT "tsCode", "tradeDate", high, low, close,
         ROW_NUMBER() OVER (PARTITION BY "tsCode" ORDER BY "tradeDate" DESC) AS rn
       FROM daily_bars
       WHERE "tradeDate" <= $1 AND "tradeDate" >= $2
     ),
     last20 AS (
       SELECT "tsCode", MAX(high) AS max_high, MIN(low) AS min_low
       FROM ranked WHERE rn <= 20 GROUP BY "tsCode"
     ),
     ma55 AS (
       SELECT "tsCode", AVG(close) AS ma55, COUNT(*)::int AS cnt
       FROM ranked WHERE rn <= 55 GROUP BY "tsCode" HAVING COUNT(*) >= 55
     ),
     today AS (SELECT "tsCode", high, low, close FROM ranked WHERE rn = 1)
     SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE t.high >= l.max_high)::int AS new_high20,
       COUNT(*) FILTER (WHERE t.low <= l.min_low)::int AS new_low20,
       COUNT(*) FILTER (WHERE t.close > m.ma55)::int AS above_ma55
     FROM today t
     LEFT JOIN last20 l ON t."tsCode" = l."tsCode"
     LEFT JOIN ma55 m ON t."tsCode" = m."tsCode"`,
    tradeDate,
    startDate
  );
  const w = win[0] ?? {};
  const total = Number(w.total ?? 0);
  const aboveMa55 = Number(w.above_ma55 ?? 0);

  // 3. RPS60 改善占比（今日 rps_60 > 5 交易日前 = 趋势改善广度，测动量转强/转弱的广度）
  let rpsImproveRatio: number | null = null;
  const prev5: any[] = await prisma.$queryRawUnsafe(
    `SELECT "tradeDate" FROM daily_bars
     WHERE "tradeDate" < $1
     ORDER BY "tradeDate" DESC LIMIT 1 OFFSET 4`,
    tradeDate
  );
  if (prev5.length > 0) {
    const prevDate = prev5[0].tradeDate;
    const imp: any[] = await prisma.$queryRawUnsafe(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE a.rps_60 > b.rps_60)::int AS improving
       FROM rps_scores a
       JOIN rps_scores b ON a."tsCode" = b."tsCode" AND b."calcDate" = $2
       WHERE a."calcDate" = $1 AND a.rps_60 IS NOT NULL AND b.rps_60 IS NOT NULL`,
      tradeDate, prevDate
    );
    const i = imp[0] ?? {};
    const impTotal = Number(i.total ?? 0);
    rpsImproveRatio = impTotal > 0 ? Number(((Number(i.improving ?? 0) / impTotal) * 100).toFixed(2)) : null;
  }

  return {
    advance: c.advance ?? null,
    decline: c.decline ?? null,
    flat: c.flat ?? null,
    limitUp: c.limit_up ?? null,
    limitDown: c.limit_down ?? null,
    newHigh20: w.new_high20 ?? null,
    newLow20: w.new_low20 ?? null,
    aboveMa55Count: aboveMa55,
    aboveMa55Ratio: total > 0 ? Number(((aboveMa55 / total) * 100).toFixed(2)) : null,
    rpsImproveRatio,
  };
}

async function upsert(tradeDate: string, b: BreadthRow) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO market_breadth
       (trade_date, advance, decline, flat, limit_up, limit_down,
        new_high20, new_low20, above_ma55_count, above_ma55_ratio,
        rps_improve_ratio)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (trade_date) DO UPDATE SET
       advance=EXCLUDED.advance, decline=EXCLUDED.decline, flat=EXCLUDED.flat,
       limit_up=EXCLUDED.limit_up, limit_down=EXCLUDED.limit_down,
       new_high20=EXCLUDED.new_high20, new_low20=EXCLUDED.new_low20,
       above_ma55_count=EXCLUDED.above_ma55_count, above_ma55_ratio=EXCLUDED.above_ma55_ratio,
       rps_improve_ratio=EXCLUDED.rps_improve_ratio`,
    tradeDate, b.advance, b.decline, b.flat, b.limitUp, b.limitDown,
    b.newHigh20, b.newLow20, b.aboveMa55Count, b.aboveMa55Ratio,
    b.rpsImproveRatio
  );
}

async function main() {
  const isInit = process.argv.includes("--init");

  // 取需要计算的交易日列表
  let dates: string[];
  if (isInit) {
    const rows: { tradeDate: string }[] = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT "tradeDate" FROM daily_bars ORDER BY "tradeDate" DESC LIMIT 60`
    );
    dates = rows.map((r: any) => r.tradeDate);
  } else {
    const latest = await prisma.dailyBar.findFirst({ orderBy: { tradeDate: "desc" }, select: { tradeDate: true } });
    if (!latest) { console.log("[market-breadth] 无日线数据"); return; }
    dates = [latest.tradeDate];
  }

  console.log(`[market-breadth] 计算 ${dates.length} 个交易日`);
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    try {
      const b = await computeForDate(d);
      await upsert(d, b);
      if ((i + 1) % 10 === 0 || i === dates.length - 1) {
        console.log(`[market-breadth] ${i + 1}/${dates.length} ${d} 涨${b.advance} 跌${b.decline} 涨停${b.limitUp} MA55上方${b.aboveMa55Ratio}%`);
      }
    } catch (e: any) {
      console.error(`[market-breadth] ${d} 失败: ${e.message?.slice(0, 100)}`);
    }
  }
  console.log("[market-breadth] 完成");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[market-breadth] 失败:", e);
  prisma.$disconnect().then(() => process.exit(1));
});
