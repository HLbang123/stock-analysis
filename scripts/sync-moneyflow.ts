/**
 * 个股资金流向同步（按 trade_date 批量拉全市场），由 run-daily 调用
 * Tushare moneyflow → stock_moneyflow
 * 按 trade_date 一次拉全市场（~5500只），同 sync-daily 模式
 *
 * 运行：npx tsx scripts/sync-moneyflow.ts [--init]
 *   --init 回补近 30 个交易日
 */

import { callTushare, toRecords } from "../lib/tushare";
import { prisma } from "../lib/db";

interface MfItem {
  ts_code: string;
  trade_date: string;
  net_mf_amount: number;
  buy_elg_amount: number;
  buy_lg_amount: number;
}

async function syncDate(tradeDate: string): Promise<number> {
  const res = await callTushare<MfItem>(
    "moneyflow",
    { trade_date: tradeDate },
    "ts_code,trade_date,net_mf_amount,buy_elg_amount,buy_lg_amount"
  );
  const rows = toRecords<MfItem>(res);
  if (rows.length === 0) return 0;

  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const values: string[] = [];
    const params: any[] = [];
    for (const r of batch) {
      const idx = params.length;
      values.push(`($${idx + 1},$${idx + 2},$${idx + 3},$${idx + 4},$${idx + 5})`);
      params.push(r.ts_code, r.trade_date, r.net_mf_amount, r.buy_elg_amount, r.buy_lg_amount);
    }
    await prisma.$executeRawUnsafe(
      `INSERT INTO stock_moneyflow (ts_code, trade_date, net_mf_amount, buy_elg_amount, buy_lg_amount)
       VALUES ${values.join(", ")}
       ON CONFLICT (ts_code, trade_date) DO UPDATE SET
         net_mf_amount=EXCLUDED.net_mf_amount, buy_elg_amount=EXCLUDED.buy_elg_amount, buy_lg_amount=EXCLUDED.buy_lg_amount`,
      ...params
    );
  }
  return rows.length;
}

async function main() {
  const isInit = process.argv.includes("--init");

  let dates: string[];
  if (isInit) {
    // 回补近 30 个交易日（从 daily_bars 取）
    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT "tradeDate" FROM daily_bars ORDER BY "tradeDate" DESC LIMIT 30`
    );
    dates = rows.map((r: any) => r.tradeDate);
  } else {
    const latest: any[] = await prisma.$queryRawUnsafe(
      `SELECT trade_date FROM stock_moneyflow ORDER BY trade_date DESC LIMIT 1`
    );
    // 从 moneyflow 最新日期+1 到 daily_bars 最新日期
    const latestBar: any[] = await prisma.$queryRawUnsafe(
      `SELECT "tradeDate" FROM daily_bars ORDER BY "tradeDate" DESC LIMIT 1`
    );
    if (!latestBar.length) { console.log("[moneyflow] 无日线数据"); await prisma.$disconnect(); return; }
    const target = latestBar[0].tradeDate;
    const startFrom = latest[0]?.trade_date || "20200101";
    if (startFrom >= target) { console.log("[moneyflow] 已是最新"); await prisma.$disconnect(); return; }
    // 从 daily_bars 取需要补的交易日
    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT "tradeDate" FROM daily_bars WHERE "tradeDate" > $1 AND "tradeDate" <= $2 ORDER BY "tradeDate"`,
      startFrom, target
    );
    dates = rows.map((r: any) => r.tradeDate);
  }

  console.log(`[moneyflow] 同步 ${dates.length} 个交易日`);
  let totalBars = 0;
  let emptyDays = 0;
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    try {
      const count = await syncDate(d);
      totalBars += count;
      if (count === 0) emptyDays++;
      if ((i + 1) % 10 === 0 || i === dates.length - 1) {
        console.log(`[moneyflow] ${i + 1}/${dates.length} ${d} 累计${totalBars}条${emptyDays > 0 ? ` ${emptyDays}天空` : ""}`);
      }
    } catch (e: any) {
      console.error(`[moneyflow] ${d} 失败: ${e.message?.slice(0, 80)}`);
    }
  }

  console.log(`[moneyflow] 完成：${totalBars} 条，${emptyDays} 天空`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[moneyflow] 失败:", e);
  prisma.$disconnect().then(() => process.exit(1));
});
