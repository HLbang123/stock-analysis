/**
 * RPS 计算引擎 v2
 * 在 TypeScript 中计算排名，SQL 批量写入
 *
 * 运行：npx tsx scripts/compute-rps.ts
 */

import { prisma } from "../lib/db";

const PERIODS = [20, 60, 120, 250] as const;

async function main() {
  // 1. 获取所有活跃股票的最新收盘价
  const latestBar = await prisma.dailyBar.findFirst({
    orderBy: { tradeDate: "desc" },
    select: { tradeDate: true },
  });
  if (!latestBar) {
    console.error("[compute-rps] 无日线数据，请先运行 sync-daily --init");
    process.exit(1);
  }
  const calcDate = latestBar.tradeDate;
  console.log(`[compute-rps] 计算日期：${calcDate}`);

  const latestPrices = await prisma.dailyBar.findMany({
    where: { tradeDate: calcDate },
    select: { tsCode: true, close: true },
  });

  const priceMap = new Map(latestPrices.map((p) => [p.tsCode, p.close]));
  console.log(`[compute-rps] ${latestPrices.length} 只股票有当日数据`);

  // 2. 获取历史交易日期列表（用于找 N 天前的日期）
  const allDates = await prisma.dailyBar.findMany({
    select: { tradeDate: true },
    distinct: ["tradeDate"],
    orderBy: { tradeDate: "desc" },
    take: 260, // 覆盖 RPS(250) + 缓冲
  });
  const dateList = allDates.map((d) => d.tradeDate);
  console.log(`[compute-rps] 可用交易日数：${dateList.length}`);

  // 3. 按周期批量计算
  const toInsert = new Map<string, Record<string, number>>();

  for (const period of PERIODS) {
    console.log(`[compute-rps] 计算 RPS(${period})...`);

    // 找到 N 个交易日前的日期
    const prevDate = dateList[period];
    if (!prevDate) {
      console.warn(`[compute-rps] RPS(${period}) 数据不足，跳过`);
      continue;
    }

    // 获取 N 天前的收盘价
    const prevPrices = await prisma.dailyBar.findMany({
      where: { tradeDate: prevDate },
      select: { tsCode: true, close: true },
    });
    const prevMap = new Map(prevPrices.map((p) => [p.tsCode, p.close]));

    // 计算每只股票的收益率
    const returns: { tsCode: string; ret: number }[] = [];
    for (const [tsCode, latestClose] of priceMap) {
      const prevClose = prevMap.get(tsCode);
      if (prevClose && prevClose > 0) {
        returns.push({
          tsCode,
          ret: ((latestClose! - prevClose) / prevClose) * 100,
        });
      }
    }

    // 按收益率降序排名
    returns.sort((a, b) => b.ret - a.ret);
    const total = returns.length;

    // 计算百分位 RPS
    for (let rank = 0; rank < returns.length; rank++) {
      const { tsCode, ret } = returns[rank];
      const rps = ((total - rank) / total) * 100; // rank=1 → RPS≈100, rank=total → RPS≈0

      if (!toInsert.has(tsCode)) {
        toInsert.set(tsCode, {
          ts_code: tsCode,
          calc_date: calcDate,
        } as any);
      }
      const entry = toInsert.get(tsCode)!;
      entry[`rps_${period}`] = Math.round(rps * 100) / 100;
      entry[`ret_${period}`] = Math.round(ret * 100) / 100;
    }

    console.log(`[compute-rps] RPS(${period})：${returns.length} 只`);
  }

  // 4. 批量写入（使用原始 SQL 做 upsert）
  const entries = Array.from(toInsert.values());
  console.log(`[compute-rps] 写入 ${entries.length} 条记录...`);

  for (let i = 0; i < entries.length; i += 500) {
    const batch = entries.slice(i, i + 500);
    const values: string[] = [];
    const params: any[] = [];

    for (const e of batch) {
      const idx = params.length;
      values.push(
        `($${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6}, $${idx + 7}, $${idx + 8}, $${idx + 9}, $${idx + 10})`
      );
      params.push(
        e.ts_code,
        e.calc_date,
        e.rps_20 ?? null,
        e.ret_20 ?? null,
        e.rps_60 ?? null,
        e.ret_60 ?? null,
        e.rps_120 ?? null,
        e.ret_120 ?? null,
        e.rps_250 ?? null,
        e.ret_250 ?? null
      );
    }

    await prisma.$executeRawUnsafe(
      `INSERT INTO rps_scores ("tsCode", "calcDate", rps_20, ret_20, rps_60, ret_60, rps_120, ret_120, rps_250, ret_250)
       VALUES ${values.join(", ")}
       ON CONFLICT ("tsCode", "calcDate")
       DO UPDATE SET
         rps_20 = EXCLUDED.rps_20, ret_20 = EXCLUDED.ret_20,
         rps_60 = EXCLUDED.rps_60, ret_60 = EXCLUDED.ret_60,
         rps_120 = EXCLUDED.rps_120, ret_120 = EXCLUDED.ret_120,
         rps_250 = EXCLUDED.rps_250, ret_250 = EXCLUDED.ret_250`,
      ...params
    );
  }

  console.log(`[compute-rps] 完成：RPS(${PERIODS.join("/")}) 已写入 ${calcDate}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[compute-rps] 失败:", e);
  prisma.$disconnect().then(() => process.exit(1));
});
