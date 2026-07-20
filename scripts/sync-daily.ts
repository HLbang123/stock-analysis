/**
 * 全市场日线同步（按交易日批量拉取）
 * 利用 Tushare daily 每次返回 6000 条的特性，按日期批量获取全市场数据
 *
 * 首次运行拉取近 300 个交易日（覆盖 RPS 250 计算）
 * 之后只拉增量（最近几天）
 *
 * 运行：npx tsx scripts/sync-daily.ts [--init]
 */

import { callTushare, toRecords } from "../lib/tushare";
import { prisma } from "../lib/db";

/** 格式化成本地日期串 YYYYMMDD（不用 toISOString，避免 UTC+8 时区把日期往前推一天） */
function fmtDate(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

interface DailyItem {
  ts_code: string;
  trade_date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  pre_close: number;
  pct_chg: number;
  vol: number;
  amount: number;
}

async function syncDate(tradeDate: string): Promise<number> {
  const res = await callTushare<DailyItem>("daily", {
    trade_date: tradeDate,
  }, "ts_code,trade_date,open,high,low,close,pre_close,pct_chg,vol,amount");

  const bars = toRecords<DailyItem>(res);
  if (bars.length === 0) return 0;

  // 原始 SQL 批量写入，跳过重复
  for (let i = 0; i < bars.length; i += 500) {
    const batch = bars.slice(i, i + 500);
    const values: string[] = [];
    const params: any[] = [];
    for (const b of batch) {
      const idx = params.length;
      values.push(`($${idx + 1},$${idx + 2},$${idx + 3},$${idx + 4},$${idx + 5},$${idx + 6},$${idx + 7},$${idx + 8},$${idx + 9},$${idx + 10})`);
      params.push(b.ts_code, b.trade_date, b.open, b.high, b.low, b.close, b.pre_close, b.pct_chg, b.vol, b.amount);
    }
    await prisma.$executeRawUnsafe(
      `INSERT INTO daily_bars ("tsCode", "tradeDate", open, high, low, close, pre_close, change_pct, vol, amount)
       VALUES ${values.join(", ")}
       ON CONFLICT ("tsCode", "tradeDate") DO NOTHING`,
      ...params
    );
  }

  return bars.length;
}

async function main() {
  const isInit = process.argv.includes("--init");

  // 获取数据库中最新的交易日
  const latestBar = await prisma.dailyBar.findFirst({
    orderBy: { tradeDate: "desc" },
    select: { tradeDate: true },
  });

  // 生成需要拉取的日期列表
  const today = new Date();
  const dates: string[] = [];

  if (isInit || !latestBar) {
    // 首次：拉取近 300 个交易日
    const d = new Date();
    d.setDate(d.getDate() - 450); // 300个交易日 ≈ 450个日历日
    const startStr = fmtDate(d);
    const endStr = fmtDate(today);
    console.log(`[sync-daily] 首次初始化：按交易日批量拉取 ${startStr} ~ ${endStr}`);

    // 生成所有日期
    const startDate = new Date(
      parseInt(startStr.slice(0, 4)),
      parseInt(startStr.slice(4, 6)) - 1,
      parseInt(startStr.slice(6, 8))
    );
    const cursor = new Date(startDate);
    while (cursor <= today) {
      dates.push(fmtDate(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
  } else {
    // 增量：补充最近几天
    const lastDate = new Date(
      parseInt(latestBar.tradeDate.slice(0, 4)),
      parseInt(latestBar.tradeDate.slice(4, 6)) - 1,
      parseInt(latestBar.tradeDate.slice(6, 8))
    );
    lastDate.setDate(lastDate.getDate() + 1);

    for (let d = new Date(lastDate); d <= today; d.setDate(d.getDate() + 1)) {
      dates.push(fmtDate(d));
    }
    console.log(`[sync-daily] 增量同步：${dates.length} 个交易日`);
  }

  let totalBars = 0;
  let emptyDays = 0;

  for (let i = 0; i < dates.length; i++) {
    const dt = dates[i];
    try {
      const count = await syncDate(dt);
      totalBars += count;
      if (count === 0) emptyDays++;

      if ((i + 1) % 20 === 0 || i === dates.length - 1) {
        console.log(
          `[sync-daily] ${i + 1}/${dates.length} 天，累计 ${totalBars} 条` +
          (emptyDays > 0 ? `，${emptyDays} 个非交易日/周末` : "")
        );
      }
    } catch (e: any) {
      console.error(`[sync-daily] ${dt} 失败: ${e.message?.slice(0, 80)}`);
    }
  }

  console.log(`\n[sync-daily] 完成：${totalBars} 条日线，${emptyDays} 天无数据（周末/节假日/停牌）`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[sync-daily] 失败:", e);
  prisma.$disconnect().then(() => process.exit(1));
});
