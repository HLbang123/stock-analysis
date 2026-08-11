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
import { runScreen, dbPickToAiPick } from '../services/ai-screen/engine';
import { getServerScreenCfg } from '../services/ai-screen/server-cfg';
import { persistRun } from '../services/ai-screen/persist';
import type { AiPick } from '../services/ai-screen/types';

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

    // 断点续跑：抓旧 run 已有 LLM 分（降级结果的部分保留分），runScreen 前喂给新候选作标尺
    // （rankAllCandidates 增量续打：只送缺分的，已打分的当标尺防漂移）
    const prevScores = existing
      ? await prisma.aiScreenPick.findMany({ where: { runId: existing.id, llmScore: { not: null } } })
      : [];
    const scoreMap = new Map(prevScores.map((r) => [r.tsCode, dbPickToAiPick(r)]));
    if (scoreMap.size > 0) console.log(`[run-ai-screen] ${preset.id} 抓到旧 run 已有 LLM 分 ${scoreMap.size} 条，断点续跑`);
    if (existing) await prisma.aiScreenRun.delete({ where: { id: existing.id } }); // picks 级联删除

    console.log(`[run-ai-screen] ${preset.id} 开跑（barDate=${barDate}, model=${cfg.model}）...`);
    const t0 = Date.now();
    const { run, candidates } = await runScreen(preset, cfg, true, scoreMap); // fullRank + 断点续打标尺
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
