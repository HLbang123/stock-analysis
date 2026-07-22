/**
 * 申万行业成分股同步（L1+L2+L3），月度跑
 * Tushare index_member_all → sw_index_member
 *
 * 运行：npx tsx scripts/sync-sw-member.ts
 */

import { callTushare, toRecords } from "../lib/tushare";
import { prisma } from "../lib/db";

interface MemberItem {
  ts_code: string;
  name: string;
  code: string;
  member_code: string;
  member_name: string;
  weight: number;
  level: string; // L1/L2/L3
  src: string;
}

async function syncLevel(level: string): Promise<number> {
  const res = await callTushare<MemberItem>("index_member_all", { src: "SW2021", level });
  const rows = toRecords<MemberItem>(res);
  if (rows.length === 0) return 0;

  // 先删该 level 旧数据
  await prisma.$executeRawUnsafe(`DELETE FROM sw_index_member WHERE level = $1`, level);

  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const values: string[] = [];
    const params: any[] = [];
    for (const r of batch) {
      const idx = params.length;
      values.push(`($${idx + 1},$${idx + 2},$${idx + 3},$${idx + 4},$${idx + 5},$${idx + 6},$${idx + 7},$${idx + 8})`);
      params.push(r.ts_code, r.name, r.code, r.member_code, r.member_name, r.weight, r.level, r.src);
    }
    await prisma.$executeRawUnsafe(
      `INSERT INTO sw_index_member (ts_code, name, code, member_code, member_name, weight, level, src)
       VALUES ${values.join(", ")}
       ON CONFLICT (ts_code, member_code, level) DO UPDATE SET
         name=EXCLUDED.name, code=EXCLUDED.code, member_name=EXCLUDED.member_name, weight=EXCLUDED.weight`,
      ...params
    );
  }
  return rows.length;
}

async function main() {
  let total = 0;
  for (const level of ["L1", "L2", "L3"]) {
    try {
      const count = await syncLevel(level);
      console.log(`[sw-member] ${level}: ${count} 条`);
      total += count;
    } catch (e: any) {
      console.error(`[sw-member] ${level} 失败: ${e.message?.slice(0, 80)}`);
    }
  }
  console.log(`[sw-member] 完成：${total} 条`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[sw-member] 失败:", e);
  prisma.$disconnect().then(() => process.exit(1));
});
