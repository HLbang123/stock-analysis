/**
 * 每日数据更新调度器
 * 按顺序执行：日线同步 → RPS 计算 → 大盘宽度 → 指数估值 → 北向资金 → 融资融券
 *
 * 用于 crontab：0 16 * * 1-5 cd /app && npx tsx scripts/run-daily.ts
 */

import { execSync } from "child_process";

const STEPS = [
  { name: "日线同步", cmd: "npx tsx scripts/sync-daily.ts" },
  { name: "RPS 计算", cmd: "npx tsx scripts/compute-rps.ts" },
  { name: "资金流向", cmd: "npx tsx scripts/sync-moneyflow.ts" },
  { name: "大盘宽度", cmd: "npx tsx scripts/compute-market-breadth.ts" },
  { name: "行业指数", cmd: "npx tsx scripts/sync-sw-daily.ts" },
  { name: "指数估值", cmd: "npx tsx scripts/sync-index-valuation.ts" },
  { name: "北向资金", cmd: "npx tsx scripts/sync-hsgt.ts" },
  { name: "融资融券", cmd: "npx tsx scripts/sync-margin.ts" },
  // 基本面(ROE) + 申万成分股 不进每日——按需手动跑
];

// 周一额外更新股票列表（上市/退市变动）
const today = new Date();
if (today.getDay() === 1) {
  STEPS.unshift({ name: "股票列表刷新", cmd: "npx tsx scripts/sync-stocks.ts" });
}

async function main() {
  console.log(`[run-daily] ===== ${new Date().toISOString()} =====`);

  for (const step of STEPS) {
    console.log(`[run-daily] → ${step.name}...`);
    try {
      execSync(step.cmd, {
        stdio: "inherit",
        cwd: process.cwd(),
        timeout: 30 * 60 * 1000, // 30 分钟超时
      });
      console.log(`[run-daily] ✓ ${step.name} 完成`);
    } catch (e: any) {
      console.error(`[run-daily] ✗ ${step.name} 失败:`, e.message);
      process.exit(1);
    }
  }

  console.log(`[run-daily] ===== 全部完成 =====`);
}

main();
