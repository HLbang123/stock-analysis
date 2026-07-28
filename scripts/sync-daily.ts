/**
 * 全市场日线同步（按交易日批量拉取）
 * 利用 Tushare daily 每次返回 6000 条的特性，按日期批量获取全市场数据
 *
 * 首次运行拉取近 300 个交易日（覆盖 RPS 250 计算）
 * 之后只拉增量（最近几天）
 *
 * 运行：npx tsx scripts/sync-daily.ts [--init] [--backfill-chip]
 *   --init           首次拉取近 300 个交易日
 *   --backfill-chip  仅回补缺 turnover_rate/circ_mv 的历史交易日
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

interface BasicItem {
  ts_code: string;
  trade_date: string;
  turnover_rate: number | null;
  circ_mv: number | null;
}

async function syncDate(tradeDate: string): Promise<number> {
  const res = await callTushare<DailyItem>("daily", {
    trade_date: tradeDate,
  }, "ts_code,trade_date,open,high,low,close,pre_close,pct_chg,vol,amount");

  const bars = toRecords<DailyItem>(res);
  if (bars.length === 0) return 0;

  // 并取 daily_basic（换手率/流通市值，筹码分布模型用），按 ts_code+trade_date 合并
  const basicMap = new Map<string, BasicItem>();
  try {
    const basicRes = await callTushare<BasicItem>("daily_basic", {
      trade_date: tradeDate,
    }, "ts_code,trade_date,turnover_rate,circ_mv");
    for (const b of toRecords<BasicItem>(basicRes)) {
      basicMap.set(`${b.ts_code}_${b.trade_date}`, b);
    }
  } catch (e: any) {
    console.error(`[sync-daily] ${tradeDate} daily_basic 失败: ${e.message?.slice(0, 80)}`);
  }

  // 原始 SQL 批量写入；DO UPDATE 保证增量重跑能刷新 turnover_rate/circ_mv
  for (let i = 0; i < bars.length; i += 500) {
    const batch = bars.slice(i, i + 500);
    const values: string[] = [];
    const params: any[] = [];
    for (const b of batch) {
      const idx = params.length;
      values.push(`($${idx + 1},$${idx + 2},$${idx + 3},$${idx + 4},$${idx + 5},$${idx + 6},$${idx + 7},$${idx + 8},$${idx + 9},$${idx + 10},$${idx + 11},$${idx + 12})`);
      const basic = basicMap.get(`${b.ts_code}_${b.trade_date}`);
      params.push(
        b.ts_code, b.trade_date, b.open, b.high, b.low, b.close,
        b.pre_close, b.pct_chg, b.vol, b.amount,
        basic?.turnover_rate ?? null, basic?.circ_mv ?? null,
      );
    }
    await prisma.$executeRawUnsafe(
      `INSERT INTO daily_bars ("tsCode", "tradeDate", open, high, low, close, pre_close, change_pct, vol, amount, turnover_rate, circ_mv)
       VALUES ${values.join(", ")}
       ON CONFLICT ("tsCode", "tradeDate") DO UPDATE SET
         turnover_rate = EXCLUDED.turnover_rate,
         circ_mv = EXCLUDED.circ_mv,
         open = EXCLUDED.open,
         high = EXCLUDED.high,
         low = EXCLUDED.low,
         close = EXCLUDED.close,
         pre_close = EXCLUDED.pre_close,
         change_pct = EXCLUDED.change_pct,
         vol = EXCLUDED.vol,
         amount = EXCLUDED.amount`,
      ...params
    );
  }

  return bars.length;
}

/** 回补模式：对已有 daily_bars 缺 turnover_rate 的交易日，按 trade_date 拉 daily_basic 补齐 */
async function backfillChip(): Promise<number> {
  const rows: { tradeDate: string }[] = await prisma.$queryRawUnsafe(
    `SELECT DISTINCT "tradeDate" FROM daily_bars WHERE turnover_rate IS NULL ORDER BY "tradeDate"`
  );
  console.log(`[sync-daily] backfill-chip：${rows.length} 个交易日待补换手率`);
  let filled = 0;
  for (let i = 0; i < rows.length; i++) {
    const tradeDate = rows[i].tradeDate;
    try {
      const basicRes = await callTushare<BasicItem>("daily_basic", {
        trade_date: tradeDate,
      }, "ts_code,trade_date,turnover_rate,circ_mv");
      const basics = toRecords<BasicItem>(basicRes);
      if (basics.length === 0) continue;
      // upsert 方案（与主同步 syncDate 同模式）：INSERT ... ON CONFLICT DO UPDATE，
      // 单语句无事务、无临时表，PK 冲突检测最快，无交互式事务超时风险。
      // 仅更新 turnover_rate/circ_mv，不动已有 OHLC。
      for (let j = 0; j < basics.length; j += 500) {
        const batch = basics.slice(j, j + 500);
        const values: string[] = [];
        const params: any[] = [];
        for (const b of batch) {
          const idx = params.length;
          values.push(`($${idx + 1},$${idx + 2},$${idx + 3},$${idx + 4})`);
          params.push(b.ts_code, b.trade_date, b.turnover_rate, b.circ_mv);
        }
        await prisma.$executeRawUnsafe(
          `INSERT INTO daily_bars ("tsCode", "tradeDate", turnover_rate, circ_mv)
           VALUES ${values.join(", ")}
           ON CONFLICT ("tsCode", "tradeDate") DO UPDATE SET
             turnover_rate = EXCLUDED.turnover_rate,
             circ_mv = EXCLUDED.circ_mv`,
          ...params
        );
      }
      filled += basics.length;
      if ((i + 1) % 20 === 0 || i === rows.length - 1) {
        console.log(`[sync-daily] backfill-chip ${i + 1}/${rows.length} 天，累计更新 ${filled} 条`);
      }
    } catch (e: any) {
      console.error(`[sync-daily] backfill ${tradeDate} 失败:`, e?.code ?? "", e?.message ?? e);
    }
  }
  return filled;
}

async function main() {
  const isInit = process.argv.includes("--init");
  const isBackfillChip = process.argv.includes("--backfill-chip");

  if (isBackfillChip) {
    const filled = await backfillChip();
    console.log(`\n[sync-daily] backfill-chip 完成：更新 ${filled} 条换手率`);
    await prisma.$disconnect();
    return;
  }

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
