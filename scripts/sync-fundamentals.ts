/**
 * 个股基本面同步（ROE/ROA/毛利率/增速）
 * Tushare fina_indicator → stock_fundamentals
 *
 * fina_indicator 必须逐只查（要求 ts_code），5000 只 × 350ms ≈ 30 分钟。
 * 财务数据季度才变，不进 run-daily，手动或月度跑一次。
 *
 * 运行：npx tsx scripts/sync-fundamentals.ts
 */

import { callTushare, toRecords } from "../lib/tushare";
import { prisma } from "../lib/db";

interface FinaItem {
  ts_code: string;
  end_date: string;
  roe: number;
  roa: number;
  grossprofit_margin: number;
  or_yoy: number;
  tr_yoy: number;
}

async function main() {
  // 取全部活跃股票代码
  const stocks: any[] = await prisma.$queryRawUnsafe(
    `SELECT ts_code FROM stocks WHERE is_active = true ORDER BY ts_code`
  );
  console.log(`[fundamentals] 共 ${stocks.length} 只股票，逐只查询（约 ${Math.round(stocks.length * 0.35 / 60)} 分钟）`);

  const rows: FinaItem[] = [];
  let failed = 0;

  for (let i = 0; i < stocks.length; i++) {
    const tsCode = stocks[i].ts_code;
    try {
      const res = await callTushare<FinaItem>(
        "fina_indicator",
        { ts_code: tsCode, limit: 1 }, // 只取最新一期
        "ts_code,end_date,roe,roa,grossprofit_margin,or_yoy,tr_yoy"
      );
      const records = toRecords<FinaItem>(res);
      if (records.length > 0) rows.push(records[0]);
    } catch {
      failed++;
    }

    if ((i + 1) % 500 === 0 || i === stocks.length - 1) {
      console.log(`[fundamentals] ${i + 1}/${stocks.length}，已获取 ${rows.length}，失败 ${failed}`);
    }
  }

  console.log(`[fundamentals] 查询完成，有效 ${rows.length} 只，失败 ${failed} 只`);

  // 批量 upsert
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const values: string[] = [];
    const params: any[] = [];
    for (const r of batch) {
      const idx = params.length;
      values.push(`($${idx + 1},$${idx + 2},$${idx + 3},$${idx + 4},$${idx + 5},$${idx + 6},$${idx + 7})`);
      params.push(r.ts_code, r.roe, r.roa, r.grossprofit_margin, r.or_yoy, r.tr_yoy, r.end_date);
    }
    await prisma.$executeRawUnsafe(
      `INSERT INTO stock_fundamentals (ts_code, roe, roa, grossprofit_margin, or_yoy, tr_yoy, period)
       VALUES ${values.join(", ")}
       ON CONFLICT (ts_code) DO UPDATE SET
         roe=EXCLUDED.roe, roa=EXCLUDED.roa, grossprofit_margin=EXCLUDED.grossprofit_margin,
         or_yoy=EXCLUDED.or_yoy, tr_yoy=EXCLUDED.tr_yoy, period=EXCLUDED.period`,
      ...params
    );
  }

  console.log(`[fundamentals] 完成，已写入 ${rows.length} 只`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[fundamentals] 失败:", e);
  prisma.$disconnect().then(() => process.exit(1));
});
