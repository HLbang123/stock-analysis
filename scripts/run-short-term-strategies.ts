/**
 * 短线策略 尾盘落库入口（由 run-daily.ts 在「日线同步」之后调用）
 *
 * 直接执行 T 日全量扫描并落库快照（当天唯一事实源）。
 *   --strategies=limit-up-three-yin,dragon-first-yin：只跑指定策略
 *
 * 不硬编码凭证：DB / FUYAO / TUSHARE 均走环境变量（.env.local）。
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { prisma } from "../lib/db";
import { parseStrategyId } from "../services/short-term-strategies/config";
import { runClosingScan } from "../services/short-term-strategies/scanner";

function flag(name: string): string | null {
  for (const a of process.argv) {
    if (a === "--" + name) return "true";
    if (a.startsWith("--" + name + "=")) return a.slice(name.length + 3);
  }
  return null;
}

async function main() {
  const strategiesRaw = flag("strategies");
  const strategies = strategiesRaw
    ? strategiesRaw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => parseStrategyId(s) !== null)
        .map((s) => parseStrategyId(s)!)
    : undefined;

  console.log("[run-short-term-strategies]", strategies ? "strategies=" + strategies.join(",") : "strategies=all");

  const result = await runClosingScan({ strategies, persist: true });

  console.log(
    "[run-short-term-strategies] tradeDate:",
    result.tradeDate,
    "market:",
    result.market.mode,
    "tradable:",
    result.market.tradable
  );
  if (!result.market.tradable) {
    console.log("[run-short-term-strategies] 退潮期/核按钮环境，默认不输出候选:", result.market.warnings.join(" / "));
  }
  for (const [sid, list] of Object.entries(result.strategies)) {
    console.log("  -", sid, "候选数:", list.length);
  }
  console.log("[run-short-term-strategies] 完成");
}

main()
  .catch((e) => {
    console.error("[run-short-term-strategies] 失败:", e?.message ?? e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
