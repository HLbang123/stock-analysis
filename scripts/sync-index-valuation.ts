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
    // 日常：按**区间**拉最近 30 个自然日（≈20 个交易日），而不是「只拉目标那一天」。
    //
    // 🔴 为什么不能只拉当日（2026-09-15 定位）：
    //    tushare `index_dailybasic` 的**当日**数据在 16:00（run-daily 的时刻）还没发布 ——
    //    实测当天查询返回 0 行，次日再查同一日期返回 6 行。
    //    这个脚本以前"能用"，是因为 `sync-daily.ts` 有个时区 bug（`d.toISOString()` 在 UTC+8
    //    把本地零点减 8 小时 → 推入的是**昨天**），导致 `daily_bars` 永远落后一天，
    //    于是目标日恰好是**已发布的昨天**。
    //    2026-07-20 部署（cd50656「Tushare/RPS 数据修复」）修好那个 bug 后，`daily_bars`
    //    当天就位 → 目标日变成**尚未发布的当天** → 从 2026-07-21 起每天 0 行，index_valuation 断档。
    //
    //    改区间拉取后：① 不再依赖发布时刻；② **天然补齐任何历史缺口（自愈）**，
    //    脚本哪天失败/机器哪天没开，第二天自己补回来。
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 30);
    const startDate = fmtDate(start);
    const endStr2 = fmtDate(end);
    let total = 0;
    for (const tsCode of IDX_CODES) {
      try {
        const res = await callTushare<IndexValItem>(
          "index_dailybasic",
          { ts_code: tsCode, start_date: startDate, end_date: endStr2 },
          fields
        );
        const rows = toRecords<IndexValItem>(res);
        if (rows.length > 0) { await upsert(rows); total += rows.length; }
      } catch (e: any) {
        console.error(`[index-val] ${tsCode} 失败: ${e.message?.slice(0, 100)}`);
      }
      await new Promise((r) => setTimeout(r, 300)); // fuyao/tushare 无内置限速，自律
    }
    console.log(`[index-val] ${startDate}~${endStr2} 共 ${total} 行`);
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[index-val] 失败:", e);
  prisma.$disconnect().then(() => process.exit(1));
});
