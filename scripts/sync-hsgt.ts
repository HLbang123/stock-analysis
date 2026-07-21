/**
 * 北向资金同步（每日，由 run-daily 调用）
 * Tushare moneyflow_hsgt → northbound_flow（含累计余额 north_total）
 * 单位：万元
 *
 * 运行：npx tsx scripts/sync-hsgt.ts [--init]
 *   --init 回补近 250 个交易日（约 400 日历日）
 */

import { callTushare, toRecords } from "../lib/tushare";
import { prisma } from "../lib/db";

function fmtDate(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

interface HsgtItem {
  trade_date: string;
  hgt: number;          // 沪股通净流入
  sgt: number;          // 深股通净流入
  north_money: number;  // 北向合计净流入
}

async function fetchRange(startDate: string, endDate: string): Promise<HsgtItem[]> {
  const res = await callTushare<HsgtItem>(
    "moneyflow_hsgt",
    { start_date: startDate, end_date: endDate },
    "trade_date,hgt,sgt,north_money"
  );
  return toRecords<HsgtItem>(res);
}

async function upsert(rows: HsgtItem[]) {
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const values: string[] = [];
    const params: any[] = [];
    for (const r of batch) {
      const idx = params.length;
      values.push(`($${idx + 1},$${idx + 2},$${idx + 3},$${idx + 4})`);
      params.push(r.trade_date, r.north_money, r.hgt, r.sgt);
    }
    await prisma.$executeRawUnsafe(
      `INSERT INTO northbound_flow (trade_date, north_money, hgt, sgt)
       VALUES ${values.join(", ")}
       ON CONFLICT (trade_date) DO UPDATE SET
         north_money=EXCLUDED.north_money, hgt=EXCLUDED.hgt, sgt=EXCLUDED.sgt`,
      ...params
    );
  }
}

/** 重算累计余额（north_total = 截至该日的 north_money 累计和） */
async function recomputeCumulative() {
  await prisma.$executeRawUnsafe(
    `UPDATE northbound_flow SET north_total = (
       SELECT COALESCE(SUM(north_money), 0) FROM northbound_flow n2
       WHERE n2.trade_date <= northbound_flow.trade_date
     )`
  );
}

async function main() {
  const isInit = process.argv.includes("--init");
  const endDate = fmtDate(new Date());

  let startDate: string;
  if (isInit) {
    const start = new Date();
    start.setDate(start.getDate() - 400); // ~250 交易日
    startDate = fmtDate(start);
  } else {
    const latest: any[] = await prisma.$queryRawUnsafe(
      `SELECT trade_date FROM northbound_flow ORDER BY trade_date DESC LIMIT 1`
    );
    startDate = latest[0]?.trade_date ?? fmtDate(new Date(Date.now() - 400 * 86400000));
  }

  console.log(`[hsgt] 拉取 ${startDate} ~ ${endDate}`);
  const rows = await fetchRange(startDate, endDate);
  if (rows.length === 0) { console.log("[hsgt] 无数据"); await prisma.$disconnect(); return; }
  console.log(`[hsgt] 获取 ${rows.length} 天`);
  await upsert(rows);
  await recomputeCumulative();
  console.log(`[hsgt] 完成，已重算累计余额`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[hsgt] 失败:", e);
  prisma.$disconnect().then(() => process.exit(1));
});
