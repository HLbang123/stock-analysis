/**
 * RPS 历史回补 — 为每个历史交易日计算 RPS(20/60/120/250) 并写入 rps_scores
 *
 * 背景：compute-rps 只算最新交易日（calcDate = latestBar.tradeDate），rps_scores
 *       没有历史数据 → market_breadth.rps_improve_ratio（RPS60 改善占比）等历史指标
 *       无法计算，大盘页「大势温度」的 RPS 线只有最近一小截。
 *       （注：RPS≥87 占比已证伪移除——RPS 是百分位排名，占比恒 ≈13% 无信息量，
 *        改为 RPS60 改善占比 = 今日 rps_60 高于 5 交易日前，测趋势改善广度）
 *
 * 运行：npx tsx scripts/backfill-rps.ts [--days=80]
 *   --days 回补最近 N 个交易日（默认 80，覆盖 market_breadth 的 60 日窗口 + 余量）
 *
 * 回补完成后必须重跑（让 RPS60 改善占比补上历史）：
 *   npx tsx scripts/compute-market-breadth.ts --init
 */

import { prisma } from "../lib/db";

const PERIODS = [20, 60, 120, 250] as const;

/** 按交易日取收盘价 Map（缓存，避免重复查询）。
 *  复权口径：存 close×adj_factor（后复权），跨除权日的 N 日收益不失真；因子缺失退化为原始价 */
const closeCache = new Map<string, Map<string, number>>();
async function getCloses(date: string): Promise<Map<string, number> | undefined> {
  let m = closeCache.get(date);
  if (m) return m;
  const rows = await prisma.dailyBar.findMany({
    where: { tradeDate: date },
    select: { tsCode: true, close: true, adjFactor: true },
  });
  m = new Map();
  for (const r of rows) if (r.close != null) m.set(r.tsCode, r.close * (r.adjFactor ?? 1));
  closeCache.set(date, m);
  return m;
}

interface RpsRow {
  ts_code: string;
  calc_date: string;
  rps_20?: number; ret_20?: number;
  rps_60?: number; ret_60?: number;
  rps_120?: number; ret_120?: number;
  rps_250?: number; ret_250?: number;
}

/** 批量 upsert 单日 RPS（镜像 compute-rps 的 SQL） */
async function upsertDate(rows: RpsRow[]) {
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const values: string[] = [];
    const params: any[] = [];
    for (const e of batch) {
      const idx = params.length;
      values.push(
        `($${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6}, $${idx + 7}, $${idx + 8}, $${idx + 9}, $${idx + 10})`
      );
      params.push(
        e.ts_code, e.calc_date,
        e.rps_20 ?? null, e.ret_20 ?? null,
        e.rps_60 ?? null, e.ret_60 ?? null,
        e.rps_120 ?? null, e.ret_120 ?? null,
        e.rps_250 ?? null, e.ret_250 ?? null
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
}

async function main() {
  const daysArg = process.argv.find((a) => a.startsWith("--days="))?.split("=")[1];
  const days = Math.min(parseInt(daysArg || "80") || 80, 2400);

  // 1. 取最近 (days + 250) 个交易日，保证最老一天的 RPS(250) 有前收盘
  const dateRows = await prisma.dailyBar.findMany({
    select: { tradeDate: true },
    distinct: ["tradeDate"],
    orderBy: { tradeDate: "desc" },
    take: days + 250,
  });
  const dates = dateRows.map((r) => r.tradeDate); // 新→旧
  if (dates.length <= 250) {
    console.error(`[backfill-rps] 历史交易日不足 ${dates.length}（需 > 250），无法回补`);
    process.exit(1);
  }
  console.log(`[backfill-rps] 交易日 ${dates.length} 个（${dates[dates.length - 1]} ~ ${dates[0]}），回补最近 ${days} 天`);

  // 2. 逐日计算 RPS 并写入
  let total = 0;
  for (let i = 0; i < days; i++) {
    const calcDate = dates[i];
    const calcCloses = await getCloses(calcDate);
    if (!calcCloses || calcCloses.size === 0) continue;

    // tsCode -> 单行（本期只放本期字段，upsert 时缺省 NULL 会覆盖旧值——沿用 compute-rps 同款语义）
    const rowByCode = new Map<string, RpsRow>();

    for (const period of PERIODS) {
      const prevDate = dates[i + period];
      if (!prevDate) continue;
      const prevCloses = await getCloses(prevDate);
      if (!prevCloses) continue;

      // 计算各股收益率
      const returns: { tsCode: string; ret: number }[] = [];
      for (const [tsCode, close] of calcCloses) {
        const prev = prevCloses.get(tsCode);
        if (prev && prev > 0) {
          returns.push({ tsCode, ret: ((close - prev) / prev) * 100 });
        }
      }
      returns.sort((a, b) => b.ret - a.ret);
      const n = returns.length;

      // 百分位 RPS
      for (let rank = 0; rank < n; rank++) {
        const { tsCode, ret } = returns[rank];
        const rps = ((n - rank) / n) * 100;
        let row = rowByCode.get(tsCode);
        if (!row) {
          row = { ts_code: tsCode, calc_date: calcDate };
          rowByCode.set(tsCode, row);
        }
        row[`rps_${period}`] = Math.round(rps * 100) / 100;
        row[`ret_${period}`] = Math.round(ret * 100) / 100;
      }
    }

    if (rowByCode.size > 0) {
      await upsertDate(Array.from(rowByCode.values()));
      total += rowByCode.size;
    }
    // 滑动窗口释放：当前日只被自身引用（prevDate 永远是更旧的日期），算完即删。
    // 否则 10 年回补会缓存 2600+ 个全市场收盘 Map（≈2-5GB）直接 OOM（08-12 实证崩在链条第 2 步）
    closeCache.delete(calcDate);
    if ((i + 1) % 10 === 0 || i === days - 1) {
      console.log(`[backfill-rps] ${i + 1}/${days} ${calcDate} 写入 ${rowByCode.size} 条`);
    }
  }

  console.log(`[backfill-rps] 完成，共写入 ${total} 条`);
  console.log("[backfill-rps] 记得重跑：npx tsx scripts/compute-market-breadth.ts --init");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[backfill-rps] 失败:", e);
  prisma.$disconnect().then(() => process.exit(1));
});
