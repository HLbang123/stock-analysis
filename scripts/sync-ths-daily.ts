/**
 * 同花顺板块指数日线同步：tushare ths_daily → ths_index_daily
 * 覆盖概念(886)/行业(881/884)/特色等全部同花顺指数，含 OHLC。
 * 大盘页板块行情 + 板块仙人指路回测的数据源。
 *
 * 运行：npx tsx scripts/sync-ths-daily.ts [--init] [--days=N]
 *   --init    回补近 60 个交易日
 *   --days=N  深度回补最近 N 个交易日（板块仙人指路回测用，建议 500）
 */

import { callTushare, toRecords } from "../lib/tushare";
import { prisma } from "../lib/db";

const DDL = `
CREATE TABLE IF NOT EXISTS ths_index_daily (
  ts_code VARCHAR(16) NOT NULL,
  trade_date VARCHAR(8) NOT NULL,
  open DOUBLE PRECISION,
  high DOUBLE PRECISION,
  low DOUBLE PRECISION,
  close DOUBLE PRECISION,
  pct_change DOUBLE PRECISION,
  vol DOUBLE PRECISION,
  PRIMARY KEY (ts_code, trade_date)
)`;

interface ThsDailyItem {
  ts_code: string;
  trade_date: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  pct_change?: number;
  vol?: number;
}

async function syncDate(tradeDate: string): Promise<number> {
  const res = await callTushare<ThsDailyItem>(
    "ths_daily",
    { trade_date: tradeDate },
    "ts_code,trade_date,open,high,low,close,pct_change,vol"
  );
  const rows = toRecords<ThsDailyItem>(res);
  if (rows.length === 0) return 0;

  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const values: string[] = [];
    const params: any[] = [];
    for (const r of batch) {
      const idx = params.length;
      values.push(`($${idx + 1},$${idx + 2},$${idx + 3},$${idx + 4},$${idx + 5},$${idx + 6},$${idx + 7},$${idx + 8})`);
      params.push(r.ts_code, r.trade_date, r.open ?? null, r.high ?? null, r.low ?? null, r.close ?? null, r.pct_change ?? null, r.vol ?? null);
    }
    await prisma.$executeRawUnsafe(
      `INSERT INTO ths_index_daily (ts_code, trade_date, open, high, low, close, pct_change, vol)
       VALUES ${values.join(", ")}
       ON CONFLICT (ts_code, trade_date) DO UPDATE SET
         open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low, close=EXCLUDED.close,
         pct_change=EXCLUDED.pct_change, vol=EXCLUDED.vol`,
      ...params
    );
  }
  return rows.length;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const isInit = process.argv.includes("--init");
  const daysArg = process.argv.find((a) => a.startsWith("--days="))?.split("=")[1];
  const startArg = process.argv.find((a) => a.startsWith("--start="))?.split("=")[1];
  // 上限 2600：覆盖 10 年（~2500 交易日）；--start=YYYYMMDD 显式指定回补起点
  const wantDays = Math.min(Math.max(parseInt(daysArg || "60") || 60, 1), 2600);

  await prisma.$executeRawUnsafe(DDL);

  let dates: string[];
  if (startArg) {
    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT "tradeDate" FROM daily_bars WHERE "tradeDate" >= '${startArg}' ORDER BY "tradeDate" DESC`
    );
    dates = rows.map((r: any) => String(r.tradeDate));
  } else if (isInit || daysArg) {
    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT "tradeDate" FROM daily_bars ORDER BY "tradeDate" DESC LIMIT ${wantDays}`
    );
    dates = rows.map((r: any) => String(r.tradeDate));
  } else {
    const latestBar: any[] = await prisma.$queryRawUnsafe(
      `SELECT "tradeDate" FROM daily_bars ORDER BY "tradeDate" DESC LIMIT 1`
    );
    if (!latestBar.length) { console.log("[ths-daily] 无日线数据"); await prisma.$disconnect(); return; }
    dates = [String(latestBar[0].tradeDate)];
  }

  console.log(`[ths-daily] 同步 ${dates.length} 个交易日`);
  let total = 0;
  for (let i = 0; i < dates.length; i++) {
    try {
      const count = await syncDate(dates[i]);
      total += count;
      if ((i + 1) % 10 === 0 || i === dates.length - 1) {
        console.log(`[ths-daily] ${i + 1}/${dates.length} ${dates[i]} 累计${total}条`);
      }
    } catch (e: any) {
      console.error(`[ths-daily] ${dates[i]} 失败: ${e.message?.slice(0, 80)}`);
    }
    await sleep(250); // tushare 限速自律
  }
  console.log(`[ths-daily] 完成：${total} 条`);
  await prisma.$disconnect();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[ths-daily] 失败:", e);
    prisma.$disconnect().then(() => process.exit(1));
  });
