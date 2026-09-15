/**
 * B1 业绩预告  forecast → forecast
 * forecast 不支持日期区间（报 "ann_date和ts_code至少输入一个参数"）→ 按交易日逐日拉。
 * 用法：SMOKE=1 bash scripts/_scratch/run-local.sh scripts/backfill/21-forecast.ts
 */
import { callTushare, toRecords } from "../../lib/tushare";
import { runDailyTask, bulkInsert } from "./_lib";
import { prisma } from "../../lib/db";

const COLS = [
  "ts_code", "ann_date", "end_date", "type",
  "p_change_min", "p_change_max", "net_profit_min", "net_profit_max", "summary",
];
interface Row { [k: string]: any }

async function main() {
  const force = process.argv.includes("--force");
  await runDailyTask({
    task: "forecast", label: "forecast", from: "20160101", force,
    handle: async (d) => {
      const res = await callTushare<Row>(
        "forecast", { ann_date: d },
        "ts_code,ann_date,end_date,type,p_change_min,p_change_max,net_profit_min,net_profit_max,summary"
      );
      const rows = toRecords<Row>(res);
      if (rows.length === 0) return 0;
      const data = rows
        .filter((r) => r.ann_date && r.end_date)
        .map((r) => [
          r.ts_code, r.ann_date, r.end_date, r.type ?? null,
          r.p_change_min ?? null, r.p_change_max ?? null,
          r.net_profit_min ?? null, r.net_profit_max ?? null,
          r.summary ? String(r.summary).slice(0, 280) : null,
        ]);
      return data.length
        ? bulkInsert("forecast", COLS, data, ["ts_code", "ann_date", "end_date"])
        : 0;
    },
  });
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[forecast] 失败:", e);
  await prisma.$disconnect();
  process.exit(1);
});
