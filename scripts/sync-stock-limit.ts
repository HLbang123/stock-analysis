/**
 * 涨跌停价同步（stk_limit → stock_limits，全市场每票每日精确涨停/跌停价）
 * 按 trade_date 一次拉全市场（6000 上限内）。R01 涨停封板/炸板判定用（前端预取）。
 *
 * 运行：npx tsx scripts/sync-stock-limit.ts [--init]
 */

import { callTushare, toRecords } from "../lib/tushare";
import { prisma } from "../lib/db";

interface LimitItem {
  ts_code: string;
  trade_date: string;
  pre_close?: number;
  limit_up?: number;
  limit_down?: number;
}

async function syncDate(tradeDate: string): Promise<number> {
  const res = await callTushare<LimitItem>(
    "stk_limit",
    { trade_date: tradeDate },
    "ts_code,trade_date,pre_close,limit_up,limit_down"
  );
  const rows = toRecords<LimitItem>(res);
  if (rows.length === 0) return 0;
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const values: string[] = [];
    const params: any[] = [];
    for (const r of batch) {
      const idx = params.length;
      values.push(`($${idx + 1},$${idx + 2},$${idx + 3},$${idx + 4},$${idx + 5})`);
      params.push(r.ts_code, r.trade_date, r.pre_close ?? null, r.limit_up ?? null, r.limit_down ?? null);
    }
    await prisma.$executeRawUnsafe(
      `INSERT INTO stock_limits (ts_code, trade_date, pre_close, limit_up, limit_down)
       VALUES ${values.join(", ")}
       ON CONFLICT (ts_code, trade_date) DO UPDATE SET
         pre_close=EXCLUDED.pre_close, limit_up=EXCLUDED.limit_up, limit_down=EXCLUDED.limit_down`,
      ...params
    );
  }
  return rows.length;
}

async function main() {
  const isInit = process.argv.includes("--init");

  let dates: string[];
  if (isInit) {
    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT "tradeDate" FROM daily_bars ORDER BY "tradeDate" DESC LIMIT 30`
    );
    dates = rows.map((r: any) => r.tradeDate);
  } else {
    const latestBar: any[] = await prisma.$queryRawUnsafe(
      `SELECT "tradeDate" FROM daily_bars ORDER BY "tradeDate" DESC LIMIT 1`
    );
    if (!latestBar.length) { console.log("[stock-limit] 无日线数据"); await prisma.$disconnect(); return; }
    const target = latestBar[0].tradeDate;
    const latestRow: any[] = await prisma.$queryRawUnsafe(
      `SELECT trade_date FROM stock_limits ORDER BY trade_date DESC LIMIT 1`
    );
    const startFrom = latestRow[0]?.trade_date || "20200101";
    if (startFrom >= target) { console.log("[stock-limit] 已是最新"); await prisma.$disconnect(); return; }
    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT "tradeDate" FROM daily_bars WHERE "tradeDate" > $1 AND "tradeDate" <= $2 ORDER BY "tradeDate"`,
      startFrom, target
    );
    dates = rows.map((r: any) => r.tradeDate);
  }

  console.log(`[stock-limit] 同步 ${dates.length} 个交易日`);
  let total = 0, emptyDays = 0;
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    try {
      const c = await syncDate(d);
      total += c;
      if (c === 0) emptyDays++;
      if ((i + 1) % 10 === 0 || i === dates.length - 1) {
        console.log(`[stock-limit] ${i + 1}/${dates.length} ${d} 累计${total}条${emptyDays > 0 ? ` ${emptyDays}天空` : ""}`);
      }
    } catch (e: any) {
      console.error(`[stock-limit] ${d} 失败: ${e.message?.slice(0, 80)}`);
    }
  }
  console.log(`[stock-limit] 完成：${total} 条，${emptyDays} 天空`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[stock-limit] 失败:", e);
  prisma.$disconnect().then(() => process.exit(1));
});
