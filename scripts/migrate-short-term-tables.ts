/**
 * 短线策略候选快照表迁移（raw SQL CREATE TABLE IF NOT EXISTS，绕过 prisma db push 禁令）
 * 表结构同步在 scripts/migrations/migrate-short-term-signals.sql。
 *
 * 用法（服务器）：npx tsx scripts/migrate-short-term-tables.ts
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { prisma } from "../lib/db";
import { SHORT_TERM_SIGNALS_DDL } from "../services/short-term-strategies/persist";

async function main() {
  for (const sql of SHORT_TERM_SIGNALS_DDL) {
    await prisma.$executeRawUnsafe(sql);
    console.log("[migrate] done:", sql.replace(/\s+/g, " ").slice(0, 72));
  }
  console.log("[migrate] 短线候选快照表迁移完成");
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[migrate] 失败:", e.message);
  await prisma.$disconnect();
  process.exit(1);
});
