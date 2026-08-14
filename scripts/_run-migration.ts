/**
 * 一次性迁移执行器：把 scripts/migrate-*.sql 应用到本地库。
 * 用法：npx tsx scripts/_run-migration.ts scripts/migrate-fund-profile.sql
 * （服务器上没有 psql 时同样可用；迁移 SQL 均幂等 IF NOT EXISTS）
 */
import { prisma } from "../lib/db";
import * as fs from "fs";

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("用法: npx tsx scripts/_run-migration.ts <sql文件>");
    process.exit(1);
  }
  const raw = fs.readFileSync(file, "utf-8");
  // 去掉 -- 行注释后按分号拆语句逐条执行（pg adapter 的 $executeRawUnsafe 不支持多语句）
  const stmts = raw
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of stmts) await prisma.$executeRawUnsafe(s);
  console.log(`[migrate] ${file} 执行完成（${stmts.length} 条语句）`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[migrate] 失败:", e.message);
  prisma.$disconnect().then(() => process.exit(1));
});
