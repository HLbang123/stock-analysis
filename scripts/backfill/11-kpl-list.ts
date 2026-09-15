/**
 * A2 开盘啦题材榜  kpl_list → kpl_list  (2018-01 起)
 * 核心：lu_desc(涨停原因) / theme(题材) / status(首板/连板) / open_time(开板) / lu_limit_order(封单)
 * 用法：SMOKE=1 bash scripts/_scratch/run-local.sh scripts/backfill/11-kpl-list.ts
 */
import { callTushare, toRecords } from "../../lib/tushare";
import { runDailyTask, bulkInsert } from "./_lib";
import { prisma } from "../../lib/db";

const TS_FIELDS =
  "ts_code,name,trade_date,lu_time,ld_time,open_time,last_time,lu_desc,tag,theme,status," +
  "net_change,bid_amount,bid_change,bid_turnover,lu_bid_vol,pct_chg,bid_pct_chg," +
  "rt_pct_chg,limit_order,amount,turnover_rate,free_float,lu_limit_order";

const COLS = [
  "ts_code","trade_date","name","lu_time","ld_time","open_time","last_time",
  "lu_desc","tag","theme","status","net_change","bid_amount","bid_change",
  "bid_turnover","lu_bid_vol","pct_chg","bid_pct_chg","rt_pct_chg","limit_order",
  "amount","turnover_rate","free_float","lu_limit_order",
];

interface Row { [k: string]: any }

async function main() {
  const force = process.argv.includes("--force");
  await runDailyTask({
    task: "kpl_list", label: "kpl_list", from: "20180101", force,
    handle: async (d) => {
      const res = await callTushare<Row>("kpl_list", { trade_date: d }, TS_FIELDS);
      const rows = toRecords<Row>(res);
      if (rows.length === 0) return 0;
      const data = rows.map((r) => [
        r.ts_code, r.trade_date ?? d, r.name ?? null, r.lu_time ?? null,
        r.ld_time ?? null, r.open_time ?? null, r.last_time ?? null,
        r.lu_desc ?? null, r.tag ?? null, r.theme ?? null, r.status ?? null,
        r.net_change ?? null, r.bid_amount ?? null, r.bid_change ?? null,
        r.bid_turnover ?? null, r.lu_bid_vol ?? null, r.pct_chg ?? null,
        r.bid_pct_chg ?? null, r.rt_pct_chg ?? null, r.limit_order ?? null,
        r.amount ?? null, r.turnover_rate ?? null, r.free_float ?? null,
        r.lu_limit_order ?? null,
      ]);
      return bulkInsert("kpl_list", COLS, data, ["ts_code", "trade_date"]);
    },
  });
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error("[kpl_list] 失败:", e); await prisma.$disconnect(); process.exit(1); });
