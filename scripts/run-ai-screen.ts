/**
 * AI 筛选 — 每日服务器调度（run-daily 挂载）
 *
 * 用服务器 env key（AI_SCREEN_API_KEY）跑全部启用策略 → 落库，全员共享同一份结果，
 * 不再依赖用户浏览器/个人 key。
 * - 当日已存在且已 AI 重排的 run → 跳过（幂等）；手动重跑走 API 覆盖
 * - 已有降级结果（llmReranked=false）→ 重跑并覆盖（删旧 run 级联删 picks）
 * - key 未配置 → 记录日志跳过（不阻断 run-daily，fatal:false）
 *
 * 运行：npx tsx scripts/run-ai-screen.ts [--force]
 */

import { prisma } from '../lib/db';
import { STRATEGY_PRESETS } from '../services/ai-screen/strategies';
import { runScreen } from '../services/ai-screen/engine';
import { getServerScreenCfg } from '../services/ai-screen/server-cfg';
import { persistRun } from '../services/ai-screen/persist';

/** 每日只跑这两个策略（旧 quality/defensive 预设保留历史数据，不再每日运行） */
const DAILY_STRATEGY_IDS = ['momentum', 'balanced'];

async function main() {
  const force = process.argv.includes('--force');
  const cfg = getServerScreenCfg();
  if (!cfg) {
    console.log('[run-ai-screen] AI_SCREEN_API_KEY 未配置，跳过（页面将显示"服务器AI未配置"）');
    await prisma.$disconnect();
    return;
  }

  const latestBar = await prisma.dailyBar.findFirst({ orderBy: { tradeDate: 'desc' }, select: { tradeDate: true } });
  if (!latestBar) {
    console.error('[run-ai-screen] 无日线数据');
    process.exit(1);
  }
  const barDate = latestBar.tradeDate;

  for (const preset of STRATEGY_PRESETS) {
    if (!preset.llmRerank || !DAILY_STRATEGY_IDS.includes(preset.id)) continue;

    const existing = await prisma.aiScreenRun.findUnique({
      where: { strategyId_barDate: { strategyId: preset.id, barDate } },
      select: { id: true, llmReranked: true },
    });
    if (existing && existing.llmReranked && !force) {
      console.log(`[run-ai-screen] ${preset.id} 当日已有 AI 重排结果，跳过`);
      continue;
    }

    // 降级结果（或 --force）→ 直接删旧 run 全量重跑（picks 级联删除）
    // 不做跨日断点续跑：LLM 故障日的缺分候选保留规则分兜底即可，明日是新的筛选
    if (existing) await prisma.aiScreenRun.delete({ where: { id: existing.id } });

    console.log(`[run-ai-screen] ${preset.id} 开跑（barDate=${barDate}, model=${cfg.model}）...`);
    const t0 = Date.now();
    const { run, candidates } = await runScreen(preset, cfg); // top-K 重排（maxOutput=30，只给入选的打分）
    await persistRun(run, candidates);
    console.log(
      `[run-ai-screen] ${preset.id} 完成：候选 ${run.candidateCount} → 入选 ${run.pickCount}` +
        `，耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s，llmReranked=${run.llmReranked}`
    );
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error('[run-ai-screen] 失败:', e);
  process.exitCode = 1;
});
