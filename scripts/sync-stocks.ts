/**
 * 全市场股票基础信息同步
 * 从 Tushare stock_basic 拉取 A 股列表 → 写入 stocks 表
 *
 * Tushare stock_basic 输出字段：
 *   ts_code, symbol, name, area, industry, market, list_date, is_hs 等
 *
 * 运行：npx tsx scripts/sync-stocks.ts
 */

import { callTushare, toRecords } from "../lib/tushare";
import { prisma } from "../lib/db";

interface StockBasic {
  ts_code: string;
  symbol: string;
  name: string;
  area: string;
  industry: string;
  market: string;
  list_date: string;
  is_hs: string;
}

function getMarket(tsCode: string): string {
  if (tsCode.endsWith(".SZ")) return "SZ";
  if (tsCode.endsWith(".BJ")) return "BJ";
  return "SH";
}

async function main() {
  console.log("[sync-stocks] 从 Tushare stock_basic 拉取全市场股票列表...");

  const res = await callTushare<StockBasic>("stock_basic", {
    list_status: "L",
  }, "ts_code,symbol,name,area,industry,market,list_date,is_hs");

  const stocks = toRecords<StockBasic>(res);
  console.log(`[sync-stocks] 获取到 ${stocks.length} 只股票`);

  let updated = 0;

  for (const s of stocks) {
    if (!s.ts_code) continue;

    const market = getMarket(s.ts_code);

    await prisma.stock.upsert({
      where: { tsCode: s.ts_code },
      update: {
        name: s.name,
        industry: s.industry || undefined,
        isActive: true,
      },
      create: {
        tsCode: s.ts_code,
        name: s.name,
        market,
        industry: s.industry || undefined,
        listDate: s.list_date || undefined,
        isActive: true,
      },
    });

    updated++;

    if (updated % 500 === 0) {
      console.log(`[sync-stocks] 已处理 ${updated}/${stocks.length}...`);
    }
  }

  // 标记退市股票（Tushare 返回的列表中没有的就是已退市）
  // 保护：如果返回数量异常少（< 3000），跳过退市标记防止误伤
  if (stocks.length >= 3000) {
    const activeCodes = stocks.map(s => s.ts_code);
    const deactivated = await prisma.stock.updateMany({
      where: {
        isActive: true,
        tsCode: { notIn: activeCodes },
      },
      data: { isActive: false },
    });
    console.log(`[sync-stocks] 标记退市：${deactivated.count} 只`);
  } else {
    console.warn(`[sync-stocks] ⚠️ 股票数量异常少 (${stocks.length})，跳过退市标记`);
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[sync-stocks] 失败:", e);
  prisma.$disconnect().then(() => process.exit(1));
});
