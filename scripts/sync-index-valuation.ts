/**
 * 指数估值同步（每日，由 run-daily 调用）
 * Tushare index_dailybasic → index_valuation（6 大指数 × 多日）
 *
 * 运行：npx tsx scripts/sync-index-valuation.ts [--init]
 *   --init 回补近 5 年（用于历史分位计算）
 */

import { callTushare, toRecords } from "../lib/tushare";
import { prisma } from "../lib/db";

function fmtDate(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

// 6 大指数：上证综指/深证成指/创业板指/上证50/中证500/沪深300
const IDX_CODES = ["000001.SH", "399001.SZ", "399006.SZ", "000016.SH", "000905.SH", "000300.SH"];

interface IndexValItem {
  ts_code: string;
  trade_date: string;
  pe: number;
  pe_ttm: number;
  pb: number;
  turnover_rate: number;
}

async function upsert(rows: IndexValItem[]) {
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const values: string[] = [];
    const params: any[] = [];
    for (const r of batch) {
      const idx = params.length;
      values.push(`($${idx + 1},$${idx + 2},$${idx + 3},$${idx + 4},$${idx + 5},$${idx + 6})`);
      params.push(r.ts_code, r.trade_date, r.pe, r.pe_ttm, r.pb, r.turnover_rate);
    }
    await prisma.$executeRawUnsafe(
      `INSERT INTO index_valuation (ts_code, trade_date, pe, pe_ttm, pb, turnover_rate)
       VALUES ${values.join(", ")}
       ON CONFLICT (ts_code, trade_date) DO UPDATE SET
         pe=EXCLUDED.pe, pe_ttm=EXCLUDED.pe_ttm, pb=EXCLUDED.pb, turnover_rate=EXCLUDED.turnover_rate`,
      ...params
    );
  }
}

async function main() {
  const isInit = process.argv.includes("--init");
  const endDate = fmtDate(new Date());
  const fields = "ts_code,trade_date,pe,pe_ttm,pb,turnover_rate";

  if (isInit) {
    // 回补 5 年：逐指数按 ts_code + 日期区间拉
    const start = new Date();
    start.setDate(start.getDate() - 1825);
    const startDate = fmtDate(start);
    let total = 0;
    for (const tsCode of IDX_CODES) {
      try {
        const res = await callTushare<IndexValItem>(
          "index_dailybasic",
          { ts_code: tsCode, start_date: startDate, end_date: endDate },
          fields
        );
        const rows = toRecords<IndexValItem>(res);
        if (rows.length > 0) { await upsert(rows); total += rows.length; }
        console.log(`[index-val] ${tsCode} ${rows.length} 行`);
      } catch (e: any) {
        console.error(`[index-val] ${tsCode} 失败: ${e.message?.slice(0, 100)}`);
      }
    }
    console.log(`[index-val] 完成，共 ${total} 行`);
  } else {
    // 日常：按最新交易日拉全部指数，过滤 6 大
    const latest: any[] = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT trade_date FROM index_valuation ORDER BY trade_date DESC LIMIT 1`
    );
    // 用 daily_bars 最新交易日作为目标（index_valuation 可能空）
    const latestBar = await prisma.dailyBar.findFirst({ orderBy: { tradeDate: "desc" }, select: { tradeDate: true } });
    const targetDate = latestBar?.tradeDate ?? endDate;
    // 已有该日数据则跳过
    if (latest[0]?.trade_date === targetDate) {
      console.log(`[index-val] ${targetDate} 已存在，跳过`);
      await prisma.$disconnect();
      return;
    }
    const res = await callTushare<IndexValItem>("index_dailybasic", { trade_date: targetDate }, fields);
    const rows = toRecords<IndexValItem>(res).filter((r) => IDX_CODES.includes(r.ts_code));
    if (rows.length > 0) await upsert(rows);
    console.log(`[index-val] ${targetDate} ${rows.length} 行`);
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[index-val] 失败:", e);
  prisma.$disconnect().then(() => process.exit(1));
});
