/**
 * RPS 计算引擎 v2
 * 在 TypeScript 中计算排名，SQL 批量写入
 *
 * 性能口径（2026-08-15，10 年 K 线落库后 daily_bars 达千万级）：
 * - 交易日历改用递归 CTE 松散索引扫描（261 次 O(log n) 索引探测），
 *   取代对全表做 DISTINCT+ORDER BY 的旧写法（千万行下会 OOM / 超时）
 * - calcDate + 4 个回看日的收盘价合并为 1 次 IN 查询（原 5 次单日全市场查询）
 *
 * 前置：daily_bars 的 tradeDate 索引已存在（schema.prisma @@index([tradeDate])，生产库已确认）
 *
 * 运行：npx tsx scripts/compute-rps.ts
 */

import { prisma } from "../lib/db";

const PERIODS = [20, 60, 120, 250] as const;

interface PriceRow {
  tsCode: string;
  tradeDate: string;
  close: number | null;
  adjFactor: number | null;
}

async function main() {
  // 1. 交易日历：递归 CTE 逐日索引回跳，一次探测取一个更早的交易日
  let t = Date.now();
  const dateRows = await prisma.$queryRawUnsafe<{ d: string }[]>(`
    WITH RECURSIVE dates AS (
      (SELECT "tradeDate" AS d FROM daily_bars ORDER BY "tradeDate" DESC LIMIT 1)
      UNION ALL
      SELECT (SELECT "tradeDate" FROM daily_bars WHERE "tradeDate" < dates.d ORDER BY "tradeDate" DESC LIMIT 1)
      FROM dates
      WHERE dates.d IS NOT NULL
    )
    SELECT d FROM dates WHERE d IS NOT NULL LIMIT 261
  `);
  const dateList = dateRows.map((r) => r.d);
  if (dateList.length === 0) {
    console.error("[compute-rps] 无日线数据，请先运行 sync-daily --init");
    process.exit(1);
  }
  const calcDate = dateList[0];
  console.log(`[compute-rps] 计算日期：${calcDate}，可用交易日 ${dateList.length}（日历 ${Date.now() - t}ms）`);

  // 2. 一次查询取齐 calcDate + 各周期回看日的收盘价（日期来自本库，格式校验后内联）
  t = Date.now();
  const neededDates = [...new Set([0, ...PERIODS].map((i) => dateList[i]).filter((d): d is string => !!d))];
  if (!neededDates.every((d) => /^\d{8}$/.test(d))) {
    console.error("[compute-rps] 交易日期格式异常", neededDates);
    process.exit(1);
  }
  const priceRows = await prisma.$queryRawUnsafe<PriceRow[]>(
    `SELECT "tsCode", "tradeDate", close, adj_factor AS "adjFactor"
     FROM daily_bars
     WHERE "tradeDate" IN (${neededDates.map((d) => `'${d}'`).join(",")})`
  );

  // 复权口径：收益 = (close0×f0)/(closeN×fN) − 1（后复权比率=真实收益，消除除权假跌幅）；
  // adj_factor 缺失（回补未完成）时退化为原始价（与旧行为一致）
  const byDate = new Map<string, Map<string, number>>();
  for (const r of priceRows) {
    if (r.close == null || r.close <= 0) continue;
    let m = byDate.get(r.tradeDate);
    if (!m) byDate.set(r.tradeDate, (m = new Map()));
    m.set(r.tsCode, r.close * (r.adjFactor ?? 1));
  }
  const priceMap = byDate.get(calcDate) ?? new Map();
  console.log(`[compute-rps] 取价 ${priceRows.length} 行 / ${neededDates.length} 个交易日（${Date.now() - t}ms）`);

  // 3. 按周期批量计算
  t = Date.now();
  const toInsert = new Map<string, Record<string, number>>();

  for (const period of PERIODS) {
    const prevDate = dateList[period];
    if (!prevDate) {
      console.warn(`[compute-rps] RPS(${period}) 数据不足，跳过`);
      continue;
    }
    const prevMap = byDate.get(prevDate);
    if (!prevMap) {
      console.warn(`[compute-rps] RPS(${period}) 回看日 ${prevDate} 无数据，跳过`);
      continue;
    }

    // 计算每只股票的收益率
    const returns: { tsCode: string; ret: number }[] = [];
    for (const [tsCode, latestClose] of priceMap) {
      const prevClose = prevMap.get(tsCode);
      if (prevClose && prevClose > 0) {
        returns.push({ tsCode, ret: ((latestClose - prevClose) / prevClose) * 100 });
      }
    }

    // 按收益率降序排名 → 百分位 RPS
    returns.sort((a, b) => b.ret - a.ret);
    const total = returns.length;
    for (let rank = 0; rank < total; rank++) {
      const { tsCode, ret } = returns[rank];
      const rps = ((total - rank) / total) * 100; // rank=1 → RPS≈100, rank=total → RPS≈0

      if (!toInsert.has(tsCode)) {
        toInsert.set(tsCode, { ts_code: tsCode, calc_date: calcDate } as any);
      }
      const entry = toInsert.get(tsCode)!;
      entry[`rps_${period}`] = Math.round(rps * 100) / 100;
      entry[`ret_${period}`] = Math.round(ret * 100) / 100;
    }

    console.log(`[compute-rps] RPS(${period})：${total} 只`);
  }
  console.log(`[compute-rps] 排名计算（${Date.now() - t}ms）`);

  // 4. 批量写入（使用原始 SQL 做 upsert）
  t = Date.now();
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

  console.log(`[compute-rps] 完成：RPS(${PERIODS.join("/")}) 已写入 ${calcDate}（写入 ${Date.now() - t}ms）`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[compute-rps] 失败:", e);
  prisma.$disconnect().then(() => process.exit(1));
});
