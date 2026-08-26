/**
 * 复盘日历 regime 回填（一次性）：对已物化的 review_calendar_days 行重算三态并落库。
 * 不碰 daily_bars；后续每日增量由 compute-review-calendar.ts 一并写入。
 * 用法：npx tsx scripts/compute-review-regime.ts
 */

import { prisma } from "../lib/db";
import { computeRegimeSeries, RegimeDayInput } from "../services/review-calendar/regime";

async function main() {
  const rows = await prisma.$queryRawUnsafe<RegimeDayInput[]>("SELECT trade_date, volume_ratio, advance, decline, idx_pct_chg FROM review_calendar_days ORDER BY trade_date");
  const map = computeRegimeSeries(rows);
  let n = 0;
  for (const r of rows) {
    const rd = map.get(r.trade_date);
    if (!rd) continue;
    await prisma.$executeRawUnsafe("UPDATE review_calendar_days SET regime = $1, regime_day = $2 WHERE trade_date = $3", rd.regime, rd.regime_day, r.trade_date);
    n++;
  }
  console.log("[review-regime] 回填 " + n + " 行");
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[review-regime] 失败:", e.message);
  await prisma.$disconnect();
  process.exit(1);
});
