/**
 * 短线策略 14:30 固定调度入口
 *
 * crontab 示例（时刻可用环境变量 SHORT_TERM_SCAN_TIME 配置，默认 14:30）：
 *   30 14 * * 1-5 cd /app && npx tsx scripts/run-short-term-strategies.ts --phase=closing
 *
 * 默认执行 T 日尾盘全量扫描并落库快照。
 *   --phase=morning：T+1 早盘刷新（复用快照 + 实时过滤，不重扫）
 *   --strategies=limit-up-three-yin,dragon-first-yin：只跑指定策略
 *
 * 不硬编码凭证：DB / FUYAO / TUSHARE 均走环境变量（.env.local）。
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { prisma } from "../lib/db";
import {
  getScanTime,
  parseStrategyId,
  isPhase,
} from "../services/short-term-strategies/config";
import { runClosingScan, runMorningRefresh } from "../services/short-term-strategies/scanner";

function flag(name: string): string | null {
  for (const a of process.argv) {
    if (a === "--" + name) return "true";
    if (a.startsWith("--" + name + "=")) return a.slice(name.length + 3);
  }
  return null;
}

async function main() {
  const phaseRaw = flag("phase") ?? "closing";
  const phase = isPhase(phaseRaw) ? phaseRaw : "closing";
  const strategiesRaw = flag("strategies");
  const strategies = strategiesRaw
    ? strategiesRaw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => parseStrategyId(s) !== null)
        .map((s) => parseStrategyId(s)!)
    : undefined;

  console.log("[run-short-term-strategies] 调度时刻配置:", getScanTime(), "(SHORT_TERM_SCAN_TIME 可覆盖)");
  console.log("[run-short-term-strategies] phase:", phase, strategies ? "strategies=" + strategies.join(",") : "strategies=all");

  const result =
    phase === "morning"
      ? await runMorningRefresh({ strategies })
      : await runClosingScan({ strategies, persist: true });

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
