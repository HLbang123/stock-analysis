/**
 * 每日数据更新调度器
 * 按顺序执行：日线同步 → RPS 计算 → 大盘宽度 → 指数估值 → 北向资金 → 融资融券
 *
 * 用于 crontab：0 16 * * 1-5 cd /app && npx tsx scripts/run-daily.ts
 */

import { execSync } from "child_process";

// 🔴 关并行：生产 PG 在 docker 里，/dev/shm 只有默认 64MB，而 work_mem=32MB 时
//    并行 worker 要在 shm 开 16MB 段 → "could not resize shared memory segment ... No space left on device"。
//    （2026-09-14 跑分层筛选历史回填时整条查询失败。）根治要重建容器加 --shm-size（需停 PG），
//    这里用会话级关闭，零停机且够用。
const PG_NOPARALLEL = "PGOPTIONS='-c max_parallel_workers_per_gather=0' ";

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
  // 分层筛选（扫描页第三个 tab）：先把新K线追加进辅助表，再算当日入选，最后补到期收益。
  // 依赖 daily_bars 已同步，故排在其后。首次部署需先跑一次：
  //   npx tsx scripts/funnel-setup.ts（建表+构建 funnel_bars）
  //   npx tsx scripts/funnel-backfill.ts（历史回填）
  // 🔴 PGOPTIONS 关并行：生产 PG 跑在 docker 里，/dev/shm 只有默认 64MB，
  //    而 work_mem=32MB 时并行 worker 要在 shm 里开 16MB 段 → 报
  //    "could not resize shared memory segment ... No space left on device"。
  //    （2026-09-14 建 funnel_bars 后跑历史回填时整条查询失败。）
  //    根治是重建容器加 --shm-size，但那样要停 PG；这里用会话级关闭，够用且零停机。
  { name: "推荐辅助表", cmd: PG_NOPARALLEL + "npx tsx scripts/funnel-setup.ts --refresh", fatal: false },
  // 每日推荐：先跑论点检测（D1/D2/D3）找出「今天有异动的板块」，再在这些板块里挑主板标的。
  // 没有板块触发异动 → 当天不推荐（宁缺勿滥）。见 services/picks/daily.ts。
  { name: "每日推荐", cmd: PG_NOPARALLEL + "npx tsx scripts/picks-scan.ts", fatal: false },
  { name: "推荐收益回填", cmd: PG_NOPARALLEL + "npx tsx scripts/funnel-backfill.ts --settle-only", fatal: false },
  // 论点检测（D1/D2/D3）依赖的原始数据：
  //   D1 景气聚类只看「近 40 天」业绩预告；D2/D3 只看「当天」。
  //   所以**取增量即可，不需要补历史**；runDailyTask 有 ingest_progress 断点，已拉过的日期不会再打接口。
  //   ⚠️ 这两步**必须保留** —— 「每日推荐」的板块标注（services/picks/daily.ts 的 hotBoards）靠它们。
  { name: "业绩预告", cmd: "npx tsx scripts/backfill/21-forecast.ts --recent=45", fatal: false },
  { name: "涨停原因", cmd: "npx tsx scripts/backfill/11-kpl-list.ts --recent=5", fatal: false },
  // 【2026-09-15 停用】原「论点表结构 / 论点扫描 / 热点线索兜底」三步已从日任务移除：
  //   产出的 thesis_cards 唯一读取方是 app/api/thesis/route.ts，而它唯一调用方
  //   components/ThesisTab.tsx 已**无任何引用**（论点 tab 于 2026-09-14 删除）
  //   → 跑着没人看，且 thesis-scan 每天最多烧 9 次 LLM（D1≤4 + D2≤3 + D3≤2）。
  //   脚本与表**保留不删**（随时可加回），只是不再调度。
  // { name: "论点表结构",   cmd: "npx tsx scripts/thesis-setup.ts", fatal: false },
  // { name: "论点扫描",     cmd: "npx tsx scripts/thesis-scan.ts",  fatal: false },
  // { name: "热点线索兜底", cmd: "npx tsx scripts/thesis-hot.ts",   fatal: false },
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
  // 【已停用】原 AI 筛选 T+N 回填（scripts/run-ai-screen.ts 及其 pick 流水线已于 2026-09-14
  //   被「论点驱动选股」取代，见下方「论点表结构 / 论点扫描」）。保留此行仅为对照，
  //   历史 ai_screen_* 数据不删；确认无人看之后连同 services/ai-screen/* 一并清理。
  // { name: "AI筛选T+N回填", cmd: "npx tsx scripts/backfill-ai-screen-eval.ts", fatal: false },
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
// ⚠️ 顺序不能动：sync-ths-index 是先删后插的全量覆盖，快照必须排在它**之后**，
//    才能把「本周刷新后生效的成分」留档。快照是概念板块 PIT 回测的唯一数据源，补不了历史。
const today = new Date();
if (today.getDay() === 1) {
  // unshift 是头插，故书写顺序与执行顺序相反
  STEPS.unshift({ name: "同花顺成分快照", cmd: "npx tsx scripts/snapshot-ths-member.ts", fatal: false });
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
