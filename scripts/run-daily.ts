/**
 * 每日数据更新调度器
 * 按顺序执行：日线同步 → RPS 计算 → 大盘宽度 → 指数估值 → 北向资金 → 融资融券
 *
 * 用于 crontab：0 16 * * 1-5 cd /app && npx tsx scripts/run-daily.ts
 */

import { execSync } from "child_process";

const STEPS: { name: string; cmd: string; fatal?: boolean }[] = [
  { name: "日线同步", cmd: "npx tsx scripts/sync-daily.ts" },
  // 同花顺板块日线：仙人指路打分的板块共振三因子（命中板块数/最强上影/板块T日量比）依赖它，
  // 必须排在「超短线扫描落库」之前。此前这条从未进过日任务，导致板块数据长期滞后。
  // 不带参数时只同步最新 1 个交易日（约 1900 行 + 1 次接口），成本很低。
  { name: "同花顺板块日线", cmd: "npx tsx scripts/sync-ths-daily.ts", fatal: false },
  // 超短线候选扫描落库：紧跟日线同步之后，确保「今日确认日」已在库，否则预筛会漏掉当天信号
  { name: "超短线扫描落库", cmd: "npx tsx scripts/run-short-term-strategies.ts", fatal: false },
  { name: "RPS 计算", cmd: "npx tsx scripts/compute-rps.ts" },
  { name: "资金流向", cmd: "npx tsx scripts/sync-moneyflow.ts" },
  { name: "基金日线", cmd: "npx tsx scripts/sync-fund-daily.ts", fatal: false },
  { name: "涨跌停价", cmd: "npx tsx scripts/sync-stock-limit.ts", fatal: false },
  { name: "大盘宽度", cmd: "npx tsx scripts/compute-market-breadth.ts" },
  // 复盘日历：指数日线 → 日级快照+冰点 → 三态重算（新功能，失败不阻断日任务）
  { name: "指数日线", cmd: "npx tsx scripts/sync-index-daily.ts", fatal: false },
  { name: "复盘日历快照", cmd: "npx tsx scripts/compute-review-calendar.ts", fatal: false },
  { name: "复盘日历状态", cmd: "npx tsx scripts/compute-review-regime.ts", fatal: false },
  // 吸筹箱体预计算（扫描器箱体条件/后续突破预警的数据源，失败不阻断）
  { name: "箱体形态", cmd: "npx tsx scripts/compute-box.ts", fatal: false },
  // 【已移除】原「行业指数」步骤（scripts/sync-sw-daily.ts）：
  //   1) 板块口径全量切换为同花顺后，sw_index_daily 已无任何读取方（唯一读者是 ai-screen 里一段死代码）；
  //   2) 该步骤在 16:00 跑时 tushare 指数类接口尚未发布，2026-09-01~09-09 连续 7 个交易日恒为 0 条，纯浪费。
  //   脚本仍保留在 scripts/，需要时可手动补采：npx tsx scripts/sync-sw-daily.ts --days=N
  { name: "指数估值", cmd: "npx tsx scripts/sync-index-valuation.ts" },
  { name: "融资融券", cmd: "npx tsx scripts/sync-margin.ts" },
  // AI 筛选 T+N 回测回填(纯分析,失败不阻断日任务)
  { name: "AI筛选T+N回填", cmd: "npx tsx scripts/backfill-ai-screen-eval.ts", fatal: false },
  // 超短线 T+N 回测回填(纯分析,失败不阻断日任务)
  { name: "超短线T+N回填", cmd: "npx tsx scripts/backfill-short-term-eval.ts", fatal: false },
  // 深度分析 T+N 回测回填(纯分析,失败不阻断日任务)
  { name: "深度分析T+N回填", cmd: "npx tsx scripts/backfill-deep-analysis-eval.ts", fatal: false },
  // 预警触发明细 T+N 回填(健康监控/周报数据源)
  { name: "预警触发T+N回填", cmd: "npx tsx scripts/backfill-alert-triggers.ts", fatal: false },
  // 波段评分(做T)信号收益回填(日内/隔日)
  { name: "做T信号收益回填", cmd: "npx tsx scripts/backfill-tscore-records.ts", fatal: false },
  // 云同步清理：过期配对 + 90天未更新快照
  { name: "云同步清理", cmd: "npx tsx scripts/cleanup-sync-snapshots.ts", fatal: false },
  // 基本面(ROE) + 申万成分股 不进每日——按需手动跑（sync-sw-member 的月度 cron 亦已移除）
];

// 周一额外更新股票列表（上市/退市变动）+ 同花顺指数成分（概念/行业成分变化低频，周级足够）
const today = new Date();
if (today.getDay() === 1) {
  STEPS.unshift({ name: "同花顺指数成分", cmd: "npx tsx scripts/sync-ths-index.ts", fatal: false });
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
      if (step.fatal === false) continue; // 非关键步骤失败不中断
      process.exit(1);
    }
  }

  console.log(`[run-daily] ===== 全部完成 =====`);
}

main();
