/**
 * 基金(ETF)日线同步 — fund_daily → fund_daily_bars
 * 只同步 ETF（51xxxx/588xxx 沪 + 159xxx 深），按 ts_code 逐只拉最近 N 日；
 * 初始化 --init 回补 250 日。ETF 约 900 只，按日增量时每只拉最近 5 日（覆盖周末缺口）。
 *
 * 运行：npx tsx scripts/sync-fund-daily.ts [--init]
 */

import { callTushare, toRecords } from "../lib/tushare";
import { prisma } from "../lib/db";

interface FundItem {
  ts_code: string;
  trade_date: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  pre_close?: number;
  pct_chg?: number;
  vol?: number;
  amount?: number;
}

const isEtfCode = (code: string) => /^(51\d{4}|588\d{3}|159\d{3})\./.test(code);

async function main() {
  const isInit = process.argv.includes("--init");
  const days = isInit ? 250 : 5;

  // ETF 列表：fund_basic 或 stocks 表？stocks 表不一定含 ETF → 用 fund_daily 自身去重 + 前缀过滤
  // 直接按 trade_date 拉全量会超单次上限(基金 1万+)，改按代码前缀无法枚举 → 从 stocks 表取代码
  const etfs: any[] = await prisma.$queryRawUnsafe(
    `SELECT "tsCode" FROM stocks WHERE "tsCode" ~ '^(51|588|159)' ORDER BY "tsCode"`
  );
  if (etfs.length === 0) {
    console.log("[fund-daily] stocks 表无 ETF 代码，跳过");
    await prisma.$disconnect();
    return;
  }
  console.log(`[fund-daily] ETF ${etfs.length} 只，拉最近 ${days} 日`);

  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - days * 86400000);
  const fmt = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

  let total = 0, failed = 0;
  for (let i = 0; i < etfs.length; i++) {
    const code = etfs[i].tsCode;
    try {
      const res = await callTushare<FundItem>(
        "fund_daily",
        { ts_code: code, start_date: fmt(startDate), end_date: fmt(endDate) },
        "ts_code,trade_date,open,high,low,close,pre_close,pct_chg,vol,amount"
      );
      const rows = toRecords<FundItem>(res);
      if (rows.length === 0) continue;
      for (let j = 0; j < rows.length; j += 500) {
        const batch = rows.slice(j, j + 500);
        const values: string[] = [];
        const params: any[] = [];
        for (const r of batch) {
          const idx = params.length;
          values.push(`($${idx + 1},$${idx + 2},$${idx + 3},$${idx + 4},$${idx + 5},$${idx + 6},$${idx + 7},$${idx + 8},$${idx + 9},$${idx + 10})`);
          params.push(
            r.ts_code, r.trade_date, r.open ?? null, r.high ?? null, r.low ?? null,
            r.close ?? null, r.pre_close ?? null, r.pct_chg ?? null, r.vol ?? null, r.amount ?? null,
          );
        }
        await prisma.$executeRawUnsafe(
          `INSERT INTO fund_daily_bars (ts_code, trade_date, open, high, low, close, pre_close, change_pct, vol, amount)
           VALUES ${values.join(", ")}
           ON CONFLICT (ts_code, trade_date) DO UPDATE SET
             open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low, close=EXCLUDED.close,
             pre_close=EXCLUDED.pre_close, change_pct=EXCLUDED.change_pct,
             vol=EXCLUDED.vol, amount=EXCLUDED.amount`,
          ...params
        );
      }
      total += rows.length;
    } catch (e: any) {
      failed++;
      console.error(`[fund-daily] ${code} 失败: ${e.message?.slice(0, 80)}`);
    }
    if ((i + 1) % 100 === 0) console.log(`[fund-daily] 进度 ${i + 1}/${etfs.length}，累计 ${total} 条`);
  }
  console.log(`[fund-daily] 完成：${total} 条，失败 ${failed} 只`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[fund-daily] 失败:", e);
  prisma.$disconnect().then(() => process.exit(1));
});
