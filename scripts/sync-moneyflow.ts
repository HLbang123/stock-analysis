/**
 * 个股 + 行业资金流向同步（同花顺 THS 口径，2026-08 起替换东财 moneyflow）
 * moneyflow_ths：全市场个股资金流（按 trade_date 一次拉全市场，6000 上限）
 * moneyflow_ind_ths：同花顺行业资金流（按 trade_date 一次拉全部 ~90 行业）
 * 旧东财 stock_moneyflow 表保留历史不再更新。
 *
 * 运行：npx tsx scripts/sync-moneyflow.ts [--init] [--from=YYYYMMDD] [--ind-only]
 *   --init 回补近 30 个交易日
 *   --from 指定起始日（用于本地研究库首次回补）。不指定时从表内最新一天续拉。
 *   --ind-only 只刷行业资金流（新增列后补数用，避免重拉 200 万行个股数据）
 *
 * ⚠️ THS 口径的数据起点（2026-09-14 实测）：
 *   moneyflow_ind_ths（行业）  → 2024-10-09 起有数据
 *   moneyflow_ths（个股）      → 2024-12-19 起有数据
 *   更早的日期会返回 0 行，回补时务必用 --from 跳过，否则空打上千次调用。
 *
 * ⚠️ 口径事实（勿再猜）：
 *   - moneyflow_ths **没有「超大单」字段**（同花顺只分 大/中/小 三档）。
 *     表内 buy_elg_amount / buy_elg_amount_rate 是**死列**，恒为 NULL，不要使用。
 *   - moneyflow_ind_ths 另含 `pct_change_stock`（龙头股当日涨跌幅）与 `close_price`
 *     （龙头股收盘价），存为 lead_stock_pct / lead_stock_close。
 *     只拿 lead_stock 名字是不够的——「龙头涨了多少 vs 行业涨了多少」才是信号。
 */

import { callTushare, toRecords } from "../lib/tushare";
import { prisma } from "../lib/db";

interface MfThsItem {
  ts_code: string;
  trade_date: string;
  name?: string;
  pct_change?: number;
  latest?: number;
  net_amount?: number;
  net_d5_amount?: number;
  buy_elg_amount?: number;
  buy_elg_amount_rate?: number;
  buy_lg_amount?: number;
  buy_lg_amount_rate?: number;
  buy_md_amount?: number;
  buy_md_amount_rate?: number;
  buy_sm_amount?: number;
  buy_sm_amount_rate?: number;
}

interface IndMfItem {
  ts_code: string;
  trade_date: string;
  industry?: string;
  lead_stock?: string;
  close?: number;
  pct_change?: number;
  company_num?: number;
  /** 龙头股当日涨跌幅（%），存 lead_stock_pct */
  pct_change_stock?: number;
  /** 龙头股收盘价，存 lead_stock_close */
  close_price?: number;
  net_buy_amount?: number;
  net_sell_amount?: number;
  net_amount?: number;
}

async function syncStockThs(tradeDate: string): Promise<number> {
  const res = await callTushare<MfThsItem>(
    "moneyflow_ths",
    { trade_date: tradeDate },
    "ts_code,trade_date,name,pct_change,latest,net_amount,net_d5_amount,buy_elg_amount,buy_elg_amount_rate,buy_lg_amount,buy_lg_amount_rate,buy_md_amount,buy_md_amount_rate,buy_sm_amount,buy_sm_amount_rate"
  );
  const rows = toRecords<MfThsItem>(res);
  if (rows.length === 0) return 0;
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const values: string[] = [];
    const params: any[] = [];
    for (const r of batch) {
      const idx = params.length;
      values.push(`($${idx + 1},$${idx + 2},$${idx + 3},$${idx + 4},$${idx + 5},$${idx + 6},$${idx + 7},$${idx + 8},$${idx + 9},$${idx + 10},$${idx + 11},$${idx + 12},$${idx + 13},$${idx + 14},$${idx + 15})`);
      params.push(
        r.ts_code, r.trade_date, r.name ?? null, r.pct_change ?? null, r.latest ?? null,
        r.net_amount ?? null, r.net_d5_amount ?? null,
        r.buy_elg_amount ?? null, r.buy_elg_amount_rate ?? null,
        r.buy_lg_amount ?? null, r.buy_lg_amount_rate ?? null,
        r.buy_md_amount ?? null, r.buy_md_amount_rate ?? null,
        r.buy_sm_amount ?? null, r.buy_sm_amount_rate ?? null,
      );
    }
    await prisma.$executeRawUnsafe(
      `INSERT INTO stock_moneyflow_ths (ts_code, trade_date, name, pct_change, latest, net_amount, net_d5_amount, buy_elg_amount, buy_elg_amount_rate, buy_lg_amount, buy_lg_amount_rate, buy_md_amount, buy_md_amount_rate, buy_sm_amount, buy_sm_amount_rate)
       VALUES ${values.join(", ")}
       ON CONFLICT (ts_code, trade_date) DO UPDATE SET
         name=EXCLUDED.name, pct_change=EXCLUDED.pct_change, latest=EXCLUDED.latest,
         net_amount=EXCLUDED.net_amount, net_d5_amount=EXCLUDED.net_d5_amount,
         buy_elg_amount=EXCLUDED.buy_elg_amount, buy_elg_amount_rate=EXCLUDED.buy_elg_amount_rate,
         buy_lg_amount=EXCLUDED.buy_lg_amount, buy_lg_amount_rate=EXCLUDED.buy_lg_amount_rate,
         buy_md_amount=EXCLUDED.buy_md_amount, buy_md_amount_rate=EXCLUDED.buy_md_amount_rate,
         buy_sm_amount=EXCLUDED.buy_sm_amount, buy_sm_amount_rate=EXCLUDED.buy_sm_amount_rate`,
      ...params
    );
  }
  return rows.length;
}

/**
 * 行业资金流表结构自举。
 * 新增列必须在这里 ADD COLUMN IF NOT EXISTS，而不是依赖外部迁移：
 * 同时更新 INSERT 列清单后，若服务器库还没加列，日任务会直接失败。
 * 放在 INSERT 之前执行可保证本地/服务器首次运行即自动补齐。
 */
async function ensureIndustryColumns(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `ALTER TABLE industry_moneyflow_ths ADD COLUMN IF NOT EXISTS lead_stock_pct double precision`
  );
  await prisma.$executeRawUnsafe(
    `ALTER TABLE industry_moneyflow_ths ADD COLUMN IF NOT EXISTS lead_stock_close double precision`
  );
}

async function syncIndustryThs(tradeDate: string): Promise<number> {
  const res = await callTushare<IndMfItem>(
    "moneyflow_ind_ths",
    { trade_date: tradeDate },
    "ts_code,trade_date,industry,lead_stock,close,pct_change,company_num,pct_change_stock,close_price,net_buy_amount,net_sell_amount,net_amount"
  );
  const rows = toRecords<IndMfItem>(res);
  if (rows.length === 0) return 0;
  const values: string[] = [];
  const params: any[] = [];
  for (const r of rows) {
    const idx = params.length;
    values.push(`($${idx + 1},$${idx + 2},$${idx + 3},$${idx + 4},$${idx + 5},$${idx + 6},$${idx + 7},$${idx + 8},$${idx + 9},$${idx + 10},$${idx + 11},$${idx + 12})`);
    params.push(
      r.ts_code, r.trade_date, r.industry ?? null, r.lead_stock ?? null, r.close ?? null,
      r.pct_change ?? null, r.company_num ?? null,
      r.pct_change_stock ?? null, r.close_price ?? null,
      r.net_buy_amount ?? null, r.net_sell_amount ?? null, r.net_amount ?? null,
    );
  }
  await prisma.$executeRawUnsafe(
    `INSERT INTO industry_moneyflow_ths (ts_code, trade_date, industry, lead_stock, close, pct_change, company_num, lead_stock_pct, lead_stock_close, net_buy_amount, net_sell_amount, net_amount)
     VALUES ${values.join(", ")}
     ON CONFLICT (ts_code, trade_date) DO UPDATE SET
       industry=EXCLUDED.industry, lead_stock=EXCLUDED.lead_stock, close=EXCLUDED.close,
       pct_change=EXCLUDED.pct_change, company_num=EXCLUDED.company_num,
       lead_stock_pct=EXCLUDED.lead_stock_pct, lead_stock_close=EXCLUDED.lead_stock_close,
       net_buy_amount=EXCLUDED.net_buy_amount, net_sell_amount=EXCLUDED.net_sell_amount,
       net_amount=EXCLUDED.net_amount`,
    ...params
  );
  return rows.length;
}

async function main() {
  const isInit = process.argv.includes("--init");
  const indOnly = process.argv.includes("--ind-only");
  const fromArg = process.argv.find((a) => a.startsWith("--from="));
  const fromDate = fromArg ? fromArg.slice("--from=".length) : null;

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
    if (!latestBar.length) { console.log("[moneyflow] 无日线数据"); await prisma.$disconnect(); return; }
    const target = latestBar[0].tradeDate;
    const latestThs: any[] = await prisma.$queryRawUnsafe(
      `SELECT trade_date FROM stock_moneyflow_ths ORDER BY trade_date DESC LIMIT 1`
    );
    const startFrom = fromDate || latestThs[0]?.trade_date || "20200101";
    if (startFrom >= target) { console.log("[moneyflow] 已是最新"); await prisma.$disconnect(); return; }
    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT "tradeDate" FROM daily_bars WHERE "tradeDate" > $1 AND "tradeDate" <= $2 ORDER BY "tradeDate"`,
      startFrom, target
    );
    dates = rows.map((r: any) => r.tradeDate);
  }

  console.log(`[moneyflow] 同步 ${dates.length} 个交易日（THS 个股 + THS 行业）`);
  await ensureIndustryColumns();
  let totalStock = 0, totalInd = 0, emptyDays = 0;
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    try {
      const c = indOnly ? 0 : await syncStockThs(d);
      let ci = 0;
      try { ci = await syncIndustryThs(d); } catch (e: any) {
        console.error(`[moneyflow] ${d} 行业失败: ${e.message?.slice(0, 80)}`);
      }
      totalStock += c; totalInd += ci;
      if (c === 0) emptyDays++;
      if ((i + 1) % 10 === 0 || i === dates.length - 1) {
        console.log(`[moneyflow] ${i + 1}/${dates.length} ${d} 个股${totalStock}条 行业${totalInd}条${emptyDays > 0 ? ` ${emptyDays}天空` : ""}`);
      }
    } catch (e: any) {
      console.error(`[moneyflow] ${d} 失败: ${e.message?.slice(0, 80)}`);
    }
  }
  console.log(`[moneyflow] 完成：个股 ${totalStock} 条，行业 ${totalInd} 条，${emptyDays} 天空`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[moneyflow] 失败:", e);
  prisma.$disconnect().then(() => process.exit(1));
});
