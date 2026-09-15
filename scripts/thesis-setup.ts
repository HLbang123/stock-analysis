/**
 * 论点系统建表（幂等）
 *
 * 单一事实源：直接读 scripts/thesis-setup.sql，剥掉 psql 元命令（\ 开头的行）后逐句执行。
 * 这样本地（psql 跑 .sql）与服务器（本脚本，服务器无 psql）用的是同一份 DDL，不会漂移。
 *
 * 运行：npx tsx scripts/thesis-setup.ts
 */

import { readFileSync } from "fs";
import { join } from "path";
import { prisma } from "../lib/db";

/** 去掉块注释。
 *  🔴 必须做：文件头部的块注释若被并进第一条语句，该语句就不再以 CREATE/INSERT 开头
 *     → 被下面的关键字过滤器丢掉 → **建表静默失败**。
 *     （本地曾因表已存在而掩盖了这个问题，服务器干净库上才暴露出来。） */
function stripBlockComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** 极简 SQL 切分：按行扫描，遇分号且不在字符串内则切一句 */
function splitStatements(rawSql: string): string[] {
  const sql = stripBlockComments(rawSql);
  const out: string[] = [];
  let buf = "";
  let inStr = false;
  for (const rawLine of sql.split("\n")) {
    const line = rawLine.trimStart();
    if (!inStr && (line.startsWith("\\") || line.startsWith("--"))) continue; // psql 元命令与注释
    for (let i = 0; i < rawLine.length; i++) {
      const ch = rawLine[i];
      if (ch === "'") inStr = !inStr;
      buf += ch;
      if (ch === ";" && !inStr) {
        const s = buf.trim();
        if (s && s !== ";") out.push(s);
        buf = "";
      }
    }
    buf += "\n";
  }
  const tail = buf.trim();
  if (tail && tail !== ";") out.push(tail);
  return out;
}

async function main() {
  const file = join(process.cwd(), "scripts", "thesis-setup.sql");
  const sql = readFileSync(file, "utf-8");
  const all = splitStatements(sql);
  const stmts = all.filter((s) => /^\s*(CREATE|ALTER|INSERT|COMMENT|DROP)/i.test(s));
  // 被过滤掉的语句必须看得见 —— 否则「建表失败」会伪装成「一切正常」
  if (all.length !== stmts.length)
    console.warn(`[thesis-setup] ⚠️ ${all.length - stmts.length} 条语句被过滤掉（不以 DDL 关键字开头），检查头注释与切分`);
  if (!stmts.length) throw new Error("SQL 未解析出任何语句，检查 scripts/thesis-setup.sql 是否存在");
  let ok = 0;
  for (const s of stmts) {
    try {
      await prisma.$executeRawUnsafe(s);
      ok++;
    } catch (e: any) {
      console.error(`✗ ${s.slice(0, 60).replace(/\s+/g, " ")}… → ${String(e.message).slice(0, 100)}`);
    }
  }
  const r: any[] = await prisma.$queryRawUnsafe(
    `SELECT (SELECT count(*)::int FROM thesis_concept_blocklist) AS bl,
            to_regclass('public.thesis_cards')::text AS cards`
  );
  console.log(`[thesis-setup] 执行 ${ok}/${stmts.length} 条；黑名单 ${r[0]?.bl} 条；thesis_cards=${r[0]?.cards}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[thesis-setup] 失败:", e);
  prisma.$disconnect().then(() => process.exit(1));
});
