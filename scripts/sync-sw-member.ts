/**
 * 申万行业成分股同步（L1+L2+L3），月度跑
 * Tushare index_classify → index_member_all → sw_index_member
 *
 * 运行：npx tsx scripts/sync-sw-member.ts
 */

import { callTushare, toRecords } from "../lib/tushare";
import { prisma } from "../lib/db";

interface ClassifyItem {
  index_code: string;
  industry_name: string;
  level: string;       // L1/L2/L3
  parent_code: string;
  src: string;
}

interface MemberItem {
  l1_code: string;
  l1_name: string;
  l2_code: string;
  l2_name: string;
  l3_code: string;
  l3_name: string;
  ts_code: string;     // 股票代码
  name: string;        // 股票名称
  in_date: string;
  out_date: string;
  is_new: string;
}

async function main() {
  // 1. 获取 SW2021 所有 L3 行业代码
  console.log("[sw-member] 获取 SW2021 行业分类...");
  const classifyRes = await callTushare<ClassifyItem>("index_classify", {
    src: "SW2021",
    level: "L3",
  });
  const l3List = toRecords<ClassifyItem>(classifyRes);
  console.log(`[sw-member] 共 ${l3List.length} 个 L3 行业`);

  if (l3List.length === 0) {
    console.error("[sw-member] 未获取到 L3 行业列表，请检查 Tushare 权限");
    process.exit(1);
  }

  // 2. 构建 parent 映射（L2→L1, L3→L2）
  const l2Map = new Map<string, ClassifyItem>();
  const l1Map = new Map<string, ClassifyItem>();

  // 获取所有 L2 和 L1
  const l2Res = await callTushare<ClassifyItem>("index_classify", {
    src: "SW2021",
    level: "L2",
  });
  for (const item of toRecords<ClassifyItem>(l2Res)) {
    l2Map.set(item.index_code, item);
  }

  const l1Res = await callTushare<ClassifyItem>("index_classify", {
    src: "SW2021",
    level: "L1",
  });
  for (const item of toRecords<ClassifyItem>(l1Res)) {
    l1Map.set(item.index_code, item);
  }

  console.log(`[sw-member] L1: ${l1Map.size}, L2: ${l2Map.size}, L3: ${l3List.length}`);

  // 3. 逐个 L3 行业拉成分股
  let total = 0;
  let l3Count = 0;

  for (const l3 of l3List) {
    const l3Code = l3.index_code;
    try {
      const res = await callTushare<MemberItem>("index_member_all", {
        l3_code: l3Code,
        is_new: "Y",
      });
      const rows = toRecords<MemberItem>(res);
      if (rows.length === 0) continue;

      // 先删该 L3 行业旧数据
      await prisma.$executeRawUnsafe(
        `DELETE FROM sw_index_member WHERE index_code = $1 AND index_level = 'L3'`,
        l3Code
      );

      // 构建批量插入：每只股票 3 行（L1/L2/L3）
      const toInsert: Array<{
        index_code: string;
        index_name: string;
        index_level: string;
        member_code: string;
        member_name: string;
      }> = [];

      for (const row of rows) {
        // L3 级别
        toInsert.push({
          index_code: row.l3_code,
          index_name: row.l3_name,
          index_level: "L3",
          member_code: row.ts_code,
          member_name: row.name,
        });
        // L2 级别
        toInsert.push({
          index_code: row.l2_code,
          index_name: row.l2_name,
          index_level: "L2",
          member_code: row.ts_code,
          member_name: row.name,
        });
        // L1 级别
        toInsert.push({
          index_code: row.l1_code,
          index_name: row.l1_name,
          index_level: "L1",
          member_code: row.ts_code,
          member_name: row.name,
        });
      }

      // 批量写入（500 条一批）
      const BATCH = 500;
      for (let i = 0; i < toInsert.length; i += BATCH) {
        const batch = toInsert.slice(i, i + BATCH);
        const values: string[] = [];
        const params: any[] = [];
        for (const r of batch) {
          const idx = params.length;
          values.push(`($${idx + 1},$${idx + 2},$${idx + 3},$${idx + 4},$${idx + 5})`);
          params.push(r.index_code, r.index_name, r.index_level, r.member_code, r.member_name);
        }
        await prisma.$executeRawUnsafe(
          `INSERT INTO sw_index_member (index_code, index_name, index_level, member_code, member_name)
           VALUES ${values.join(", ")}
           ON CONFLICT (index_code, member_code, index_level) DO UPDATE SET
             index_name=EXCLUDED.index_name, member_name=EXCLUDED.member_name`,
          ...params
        );
      }

      total += rows.length;
      l3Count++;
      if (l3Count % 20 === 0) {
        console.log(`[sw-member] 进度: ${l3Count}/${l3List.length} 个 L3 行业, ${total} 只成分股`);
      }
    } catch (e: any) {
      console.error(`[sw-member] ${l3Code} 失败: ${e.message?.slice(0, 80)}`);
    }
  }

  console.log(`[sw-member] 完成：${l3Count} 个 L3 行业, ${total} 只成分股记录`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[sw-member] 失败:", e);
  prisma.$disconnect().then(() => process.exit(1));
});
