/**
 * ETF 品种档案同步 — tushare fund_basic → fund_profiles
 * 拉全量场内基金（不过滤 status，保留摘牌记录供清盘/历史分析），
 * 经 lib/fund-classify.ts 派生 assetClass/tPlus0/limitPct 后 upsert。
 * fund_profiles 是 ETF 注册表唯一事实源（sync-fund-daily 的清单也来自这里）。
 *
 * 运行：npx tsx scripts/sync-fund-profiles.ts [--init]
 *   --init  全量（等同默认，fund_basic 单次可拉 15000 条，一次就够；保留 flag 仅为风格统一）
 */

import { callTushare, toRecords } from "../lib/tushare";
import { prisma } from "../lib/db";
import { classifyFund } from "../lib/fund-classify";

interface FundBasicItem {
  ts_code: string;
  name: string;
  fund_type?: string;
  invest_type?: string;
  benchmark?: string;
  list_date?: string;
  delist_date?: string;
  status?: string; // D摘牌 I发行 L上市中
}

// 只收 ETF 代码段（与 lib/identify.ts isETF 同口径；fund_basic market=E 还含 LOF/封闭式，先不纳管）
const isEtfTsCode = (code: string) => /^(51\d{4}|588\d{3}|159\d{3})\./.test(code);

async function main() {
  const res = await callTushare<FundBasicItem>(
    "fund_basic",
    { market: "E" },
    "ts_code,name,fund_type,invest_type,benchmark,list_date,delist_date,status"
  );
  const rows = toRecords<FundBasicItem>(res).filter((r) => isEtfTsCode(r.ts_code));
  console.log(`[fund-profiles] fund_basic 返回 ETF ${rows.length} 只`);

  let upserted = 0, failed = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    try {
      await prisma.$transaction(
        batch.map((r) => {
          const c = classifyFund({
            tsCode: r.ts_code,
            name: r.name,
            fundType: r.fund_type,
            benchmark: r.benchmark,
          });
          return prisma.fundProfile.upsert({
            where: { tsCode: r.ts_code },
            create: {
              tsCode: r.ts_code,
              name: r.name,
              fundType: r.fund_type ?? null,
              investType: r.invest_type ?? null,
              benchmark: r.benchmark ?? null,
              listDate: r.list_date || null,
              delistDate: r.delist_date || null,
              assetClass: c.assetClass,
              tPlus0: c.tPlus0,
              limitPct: c.limitPct,
              isActive: r.status === "L",
            },
            update: {
              name: r.name,
              fundType: r.fund_type ?? null,
              investType: r.invest_type ?? null,
              benchmark: r.benchmark ?? null,
              listDate: r.list_date || null,
              delistDate: r.delist_date || null,
              assetClass: c.assetClass,
              tPlus0: c.tPlus0,
              limitPct: c.limitPct,
              isActive: r.status === "L",
            },
          });
        })
      );
      upserted += batch.length;
    } catch (e: any) {
      failed += batch.length;
      console.error(`[fund-profiles] 批次 ${i} 失败: ${e.message?.slice(0, 120)}`);
    }
  }

  const byClass = await prisma.$queryRawUnsafe<{ asset_class: string | null; n: bigint }[]>(
    `SELECT asset_class, count(*) AS n FROM fund_profiles WHERE is_active GROUP BY asset_class ORDER BY n DESC`
  );
  console.log(`[fund-profiles] 完成：upsert ${upserted}，失败 ${failed}`);
  for (const r of byClass) console.log(`  ${r.asset_class ?? "null"}: ${r.n}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[fund-profiles] 失败:", e);
  prisma.$disconnect().then(() => process.exit(1));
});
