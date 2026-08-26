/**
 * 宽基指数日线同步（复盘日历冰点规则数据源）
 * Tushare index_daily（免费接口）→ index_daily 表
 *
 * 用法：
 *   npx tsx scripts/sync-index-daily.ts --init      # 全量回补 20160506→今天
 *   npx tsx scripts/sync-index-daily.ts --days 10    # 最近 10 个自然日增量
 *   npx tsx scripts/sync-index-daily.ts              # 默认：表内最新日期→今天
 */

import { callTushare } from "../lib/tushare";
import { prisma } from "../lib/db";

const IDX_CODES = ["000001.SH", "399001.SZ", "399006.SZ", "000300.SH"]; // 上证/深证/创业板/沪深300
const BACKFILL_START = "20160506"; // 与 daily_bars 起始日对齐

const pad = (n: number) => String(n).padStart(2, "0");
const todayStr = () => {
  const d = new Date();
  return String(d.getFullYear()) + pad(d.getMonth() + 1) + pad(d.getDate());
};

interface IdxRow {
  ts_code: string; trade_date: string;
  open: number | null; high: number | null; low: number | null; close: number | null;
  pct_chg: number | null; vol: number | null; amount: number | null;
}

const toNum = (v: unknown): number | null => (v == null ? null : Number(v));

async function fetchIndex(tsCode: string, start: string, end: string): Promise<IdxRow[]> {
  const res = await callTushare("index_daily", { ts_code: tsCode, start_date: start, end_date: end });
  const fields = res.data?.fields ?? [];
  const items = res.data?.items ?? [];
  const i = (f: string) => fields.indexOf(f);
  const iTs = i("ts_code"), iDate = i("trade_date"), iOpen = i("open"), iHigh = i("high"),
    iLow = i("low"), iClose = i("close"), iPct = i("pct_chg"), iVol = i("vol"), iAmt = i("amount");
  return items.map((r: any[]) => ({
    ts_code: String(r[iTs]), trade_date: String(r[iDate]),
    open: toNum(r[iOpen]), high: toNum(r[iHigh]), low: toNum(r[iLow]),
    close: toNum(r[iClose]), pct_chg: toNum(r[iPct]), vol: toNum(r[iVol]), amount: toNum(r[iAmt]),
  }));
}

async function upsert(rows: IdxRow[]) {
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const values: string[] = [];
    const params: any[] = [];
    for (const r of batch) {
      const b = params.length;
      values.push("($" + (b + 1) + ",$" + (b + 2) + ",$" + (b + 3) + ",$" + (b + 4) + ",$" + (b + 5) + ",$" + (b + 6) + ",$" + (b + 7) + ",$" + (b + 8) + ",$" + (b + 9) + ")");
      params.push(r.ts_code, r.trade_date, r.open, r.high, r.low, r.close, r.pct_chg, r.vol, r.amount);
    }
    await prisma.$executeRawUnsafe(
      "INSERT INTO index_daily (ts_code, trade_date, open, high, low, close, pct_chg, vol, amount) " +
      "VALUES " + values.join(", ") + " " +
      "ON CONFLICT (ts_code, trade_date) DO UPDATE SET open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low, " +
      "close=EXCLUDED.close, pct_chg=EXCLUDED.pct_chg, vol=EXCLUDED.vol, amount=EXCLUDED.amount",
      ...params
    );
  }
}

async function main() {
  const arg = process.argv[2];
  const daysIdx = process.argv.indexOf("--days");
  const isInit = arg === "--init";
  const today = todayStr();

  let start: string;
  if (isInit) {
    start = BACKFILL_START;
    console.log("[sync-index-daily] --init 全量回补 " + start + " → " + today);
  } else if (daysIdx >= 0 && process.argv[daysIdx + 1]) {
    const n = parseInt(process.argv[daysIdx + 1], 10);
    const d = new Date(Date.now() - n * 86400000);
    start = String(d.getFullYear()) + pad(d.getMonth() + 1) + pad(d.getDate());
    console.log("[sync-index-daily] 增量 最近 " + n + " 天 " + start + " → " + today);
  } else {
    const maxRow = await prisma.$queryRawUnsafe<{ mx: string | null }[]>(`SELECT MAX(trade_date) AS mx FROM index_daily`);
    const mx = maxRow[0]?.mx;
    if (!mx) {
      console.error("[sync-index-daily] index_daily 为空，请先跑 --init");
      process.exit(1);
    }
    start = mx;
    console.log("[sync-index-daily] 增量 " + start + " → " + today);
  }

  let total = 0;
  const startYear = parseInt(start.slice(0, 4), 10);
  const endYear = parseInt(today.slice(0, 4), 10);
  for (const code of IDX_CODES) {
    for (let y = startYear; y <= endYear; y++) {
      const s = y === startYear ? start : String(y) + "0101";
      const e = y === endYear ? today : String(y) + "1231";
      const rows = await fetchIndex(code, s, e);
      if (rows.length) {
        await upsert(rows);
        total += rows.length;
        console.log("[sync-index-daily] " + code + " " + s + "→" + e + " 写入 " + rows.length + " 行");
      }
    }
  }
  console.log("[sync-index-daily] 完成，共 " + total + " 行");
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[sync-index-daily] 失败:", e.message);
  await prisma.$disconnect();
  process.exit(1);
});
