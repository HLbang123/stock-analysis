/**
 * 融资融券市场总量同步（每日，由 run-daily 调用）
 * Tushare margin → margin_total（一行/交易所/日，SSE+SZSE）
 * 单位：元
 *
 * 运行：npx tsx scripts/sync-margin.ts [--init]
 *   --init 回补近 250 个交易日
 */

import { callTushare, toRecords } from "../lib/tushare";
import { prisma } from "../lib/db";

function fmtDate(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

interface MarginItem {
  trade_date: string;
  exchange_id: string; // SSE / SZSE（Tushare 字段名是 exchange_id）
  rzye: number;     // 融资余额
  rqye: number;     // 融券余额
  rzmre: number;    // 融资买入额
  rzche: number;    // 融资偿还额
  rzrqye: number;   // 融资融券余额
}

async function fetchRange(startDate: string, endDate: string): Promise<MarginItem[]> {
  const res = await callTushare<MarginItem>(
    "margin",
    { start_date: startDate, end_date: endDate },
    "trade_date,exchange_id,rzye,rqye,rzmre,rzche,rzrqye"
  );
  return toRecords<MarginItem>(res);
}

async function upsert(rows: MarginItem[]) {
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const values: string[] = [];
    const params: any[] = [];
    for (const r of batch) {
      const idx = params.length;
      values.push(`($${idx + 1},$${idx + 2},$${idx + 3},$${idx + 4},$${idx + 5},$${idx + 6},$${idx + 7})`);
      params.push(r.trade_date, r.exchange_id, r.rzye, r.rqye, r.rzmre, r.rzche, r.rzrqye);
    }
    await prisma.$executeRawUnsafe(
      `INSERT INTO margin_total (trade_date, exchange, rzye, rqye, rzmre, rzche, rzrqye)
       VALUES ${values.join(", ")}
       ON CONFLICT (trade_date, exchange) DO UPDATE SET
         rzye=EXCLUDED.rzye, rqye=EXCLUDED.rqye, rzmre=EXCLUDED.rzmre,
         rzche=EXCLUDED.rzche, rzrqye=EXCLUDED.rzrqye`,
      ...params
    );
  }
}

async function main() {
  const isInit = process.argv.includes("--init");
  const endDate = fmtDate(new Date());

  let startDate: string;
  if (isInit) {
    const start = new Date();
    start.setDate(start.getDate() - 400);
    startDate = fmtDate(start);
  } else {
    const latest: any[] = await prisma.$queryRawUnsafe(
      `SELECT trade_date FROM margin_total ORDER BY trade_date DESC LIMIT 1`
    );
    startDate = latest[0]?.trade_date ?? fmtDate(new Date(Date.now() - 400 * 86400000));
  }

  console.log(`[margin] 拉取 ${startDate} ~ ${endDate}`);
  const rows = await fetchRange(startDate, endDate);
  if (rows.length === 0) { console.log("[margin] 无数据"); await prisma.$disconnect(); return; }
  console.log(`[margin] 获取 ${rows.length} 行`);
  await upsert(rows);
  console.log(`[margin] 完成`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[margin] 失败:", e);
  prisma.$disconnect().then(() => process.exit(1));
});
