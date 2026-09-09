/**
 * 一次性迁移：stocks.industry（申万行业名）→ 同花顺一级行业名（881xxx.TI，一对一）
 * 统一板块口径：行业标签用同花顺一级行业；板块选择/情绪用同花顺概念（cn_concept）。
 * 运行：npx tsx scripts/migrate-stock-industry-ths.ts
 */
import { prisma } from "../lib/db";

async function main() {
  // 单条 UPDATE：881 一级行业映射（每只票严格一对一）
  const res: any[] = await prisma.$queryRawUnsafe(`
    UPDATE stocks s
    SET industry = t.name
    FROM (
      SELECT m.ts_code, MIN(i.name) AS name
      FROM ths_index_member m
      JOIN ths_index i ON i.thscode = m.thscode
      WHERE i.tag = 'industry' AND i.thscode LIKE '881%'
      GROUP BY m.ts_code
    ) t
    WHERE s.ts_code = t.ts_code
    RETURNING s.ts_code
  `);
  console.log(`[migrate-stock-industry-ths] 已更新 ${res.length} 只标的的行业为同花顺一级行业`);
  await prisma.$disconnect();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[migrate-stock-industry-ths] 失败:", e);
    prisma.$disconnect().then(() => process.exit(1));
  });
