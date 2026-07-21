/**
 * 市场宽度 + 占比 预计算（每日，由 run-daily 调用）
 *
 * 从 daily_bars 聚合：涨跌家数 / 涨跌停 / 20日新高新低 / MA55 上方占比
 * 从 rps_scores 聚合：RPS≥87 强势股占比
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
  strongRpsCount: number | null;
  strongRpsRatio: number | null;
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

  // 3. RPS 强势股占比（rps_scores 当日有数据才有）
  const rps: any[] = await prisma.$queryRawUnsafe(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE rps_250 >= 87)::int AS strong
     FROM rps_scores WHERE "calcDate" = $1`,
    tradeDate
  );
  const r = rps[0] ?? {};
  const rpsTotal = Number(r.total ?? 0);
  const strong = Number(r.strong ?? 0);

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
    strongRpsCount: rpsTotal > 0 ? strong : null,
    strongRpsRatio: rpsTotal > 0 ? Number(((strong / rpsTotal) * 100).toFixed(2)) : null,
  };
}

async function upsert(tradeDate: string, b: BreadthRow) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO market_breadth
       (trade_date, advance, decline, flat, limit_up, limit_down,
        new_high20, new_low20, above_ma55_count, above_ma55_ratio,
        strong_rps_count, strong_rps_ratio)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (trade_date) DO UPDATE SET
       advance=EXCLUDED.advance, decline=EXCLUDED.decline, flat=EXCLUDED.flat,
       limit_up=EXCLUDED.limit_up, limit_down=EXCLUDED.limit_down,
       new_high20=EXCLUDED.new_high20, new_low20=EXCLUDED.new_low20,
       above_ma55_count=EXCLUDED.above_ma55_count, above_ma55_ratio=EXCLUDED.above_ma55_ratio,
       strong_rps_count=EXCLUDED.strong_rps_count, strong_rps_ratio=EXCLUDED.strong_rps_ratio`,
    tradeDate, b.advance, b.decline, b.flat, b.limitUp, b.limitDown,
    b.newHigh20, b.newLow20, b.aboveMa55Count, b.aboveMa55Ratio,
    b.strongRpsCount, b.strongRpsRatio
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
