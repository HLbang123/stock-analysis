/**
 * 超短线 T+N 回测回填脚本
 *
 * 用法：
 *   npx tsx scripts/backfill-short-term-eval.ts               # 近 120 天增量
 *   npx tsx scripts/backfill-short-term-eval.ts --since=2026-01-01
 *   npx tsx scripts/backfill-short-term-eval.ts --N=5
 */

import { prisma } from "../lib/db";
import { backfillShortTermEval } from "../services/short-term-strategies/eval";

async function main() {
  const sinceArg = process.argv.find((a) => a.startsWith("--since="));
  const since = sinceArg ? sinceArg.slice(8) : undefined;
  const argN = process.argv.find((a) => a.startsWith("--N="));
  const ns = argN ? [parseInt(argN.slice(4), 10)].filter((n) => Number.isFinite(n)) : undefined;

  const result = await backfillShortTermEval({ since, ns });
  console.log("[backfill-short-term-eval] 完成", JSON.stringify(result));
}

main()
  .catch((e) => {
    console.error("[backfill-short-term-eval] 失败:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });