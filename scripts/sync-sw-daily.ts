/**
 * 申万行业指数日线同步，由 run-daily 调用
 * Tushare sw_daily → sw_index_daily
 * 按 trade_date 一次拉全部行业指数
 *
 * 运行：npx tsx scripts/sync-sw-daily.ts [--init] [--days=N]
 *   --init    回补近 60 个交易日
 *   --days=N  深度回补最近 N 个交易日（配合因子回测用）
 */

import { callTushare, toRecords } from "../lib/tushare";
import { prisma } from "../lib/db";

interface SwItem {
  ts_code: string;
  trade_date: string;
  close: number;
  vol: number;
  amount: number;
}

/**
 * 同步单个交易日的行业指数。
 * pct_chg：Tushare sw_daily 接口该字段长期返回 null（2026-08 实测全表 24 万行全空，
 * 导致 theme_heat 因子恒为中性 50），改用上一交易日 close 本地推算，与接口脱钩。
 */
async function syncDate(tradeDate: string): Promise<number> {
  const res = await callTushare<SwItem>("sw_daily", { trade_date: tradeDate },
    "ts_code,trade_date,close,vol,amount");
  const rows = toRecords<SwItem>(res);
  if (rows.length === 0) return 0;

  // 上一交易日各指数 close（推算 pct_chg 用）
  const prevRows: { ts_code: string; close: number }[] = await prisma.$queryRawUnsafe(
    `SELECT ts_code, close FROM sw_index_daily
     WHERE trade_date = (SELECT MAX(trade_date) FROM sw_index_daily WHERE trade_date < $1)`,
    tradeDate
  );
  const prevClose = new Map(prevRows.map((r) => [r.ts_code, r.close]));

  const values: string[] = [];
  const params: any[] = [];
  for (const r of rows) {
    const pc = prevClose.get(r.ts_code);
    const pct = pc && pc > 0 && r.close > 0 ? Math.round(((r.close / pc - 1) * 100) * 10000) / 10000 : null;
    const idx = params.length;
    values.push(`($${idx + 1},$${idx + 2},$${idx + 3},$${idx + 4},$${idx + 5},$${idx + 6})`);
    params.push(r.ts_code, r.trade_date, r.close, pct, r.vol, r.amount);
  }
  await prisma.$executeRawUnsafe(
    `INSERT INTO sw_index_daily (ts_code, trade_date, close, pct_chg, vol, amount)
     VALUES ${values.join(", ")}
     ON CONFLICT (ts_code, trade_date) DO UPDATE SET
       close=EXCLUDED.close, pct_chg=EXCLUDED.pct_chg, vol=EXCLUDED.vol, amount=EXCLUDED.amount`,
    ...params
  );
  return rows.length;
}

async function main() {
  const isInit = process.argv.includes("--init");
  const daysArg = process.argv.find((a) => a.startsWith("--days="))?.split("=")[1];
  const wantDays = Math.min(Math.max(parseInt(daysArg || "60") || 60, 1), 800);
  let dates: string[];
  if (isInit || daysArg) {
    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT "tradeDate" FROM daily_bars ORDER BY "tradeDate" DESC LIMIT ${wantDays}`
    );
    dates = rows.map((r: any) => r.tradeDate);
  } else {
    const latestBar: any[] = await prisma.$queryRawUnsafe(
      `SELECT "tradeDate" FROM daily_bars ORDER BY "tradeDate" DESC LIMIT 1`
    );
    if (!latestBar.length) { console.log("[sw-daily] 无日线数据"); await prisma.$disconnect(); return; }
    dates = [latestBar[0].tradeDate];
  }

  console.log(`[sw-daily] 同步 ${dates.length} 个交易日`);
  let total = 0;
  for (let i = 0; i < dates.length; i++) {
    try {
      const count = await syncDate(dates[i]);
      total += count;
      if ((i + 1) % 10 === 0 || i === dates.length - 1) {
        console.log(`[sw-daily] ${i + 1}/${dates.length} ${dates[i]} 累计${total}条`);
      }
    } catch (e: any) {
      console.error(`[sw-daily] ${dates[i]} 失败: ${e.message?.slice(0, 80)}`);
    }
  }
  console.log(`[sw-daily] 完成：${total} 条`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[sw-daily] 失败:", e);
  prisma.$disconnect().then(() => process.exit(1));
});
