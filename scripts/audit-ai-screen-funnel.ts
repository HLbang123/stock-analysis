/**
 * AI 筛选流水线漏斗审计（不落库、不调 LLM、不改生产）
 * 译自 a-share-accumulation-breakout audit_funnel.py：逐层淘汰计数 + 未命中主因 + 瓶颈诊断
 *
 * 回答三个问题：
 *   1. 哪一层砍掉最多票（SQL 硬筛 → enrich 技术硬筛 → 风险层 → topN）
 *   2. enrich 淘汰的主因分布（量比/波动/回撤/MA非多头 谁是主要矛盾）
 *   3. SQL 池是否触顶 200（触顶 = enrich 只能看到 RPS 前 200，硬筛有隐形截断）
 *
 * 另附 DB 侧近 10 次 run 概览（候选/入选/LLM 覆盖率/降级/市场状态）
 * 与近 30 日入选 pick 的 riskFlags 分布（看风险层实际在拦什么）。
 *
 * 用法: npx tsx scripts/audit-ai-screen-funnel.ts [--preset=balanced,momentum]
 */

import { prisma } from '../lib/db';
import { STRATEGY_PRESETS } from '../services/ai-screen/strategies';
import { fetchCandidates } from '../services/ai-screen/candidates';
import { enrichWithReason } from '../services/ai-screen/engine';
import { computeScreenScores } from '../services/ai-screen/scorer';
import { applyRiskOverlay } from '../services/ai-screen/risk';

const PRESET_IDS = (process.argv.find((a) => a.startsWith('--preset='))?.split('=')[1] || 'balanced,momentum').split(',');

async function main() {
  for (const id of PRESET_IDS) {
    const preset = STRATEGY_PRESETS.find((s) => s.id === id);
    if (!preset) { console.log(`[funnel] 未知策略 ${id}，跳过`); continue; }

    console.log(`\n========== 策略「${preset.name}」(${id}) 漏斗 ==========`);
    const { barDate, candidates } = await fetchCandidates(preset);
    console.log(`L1 SQL 硬筛池: ${candidates.length} 只（数据日 ${barDate}，LIMIT 200）`);
    if (candidates.length >= 200) {
      console.log('  ⚠ 触顶 200：池外还有满足硬筛的票被 RPS 排名截断，enrich/LLM 永远看不到它们。');
      console.log('    若要缓解：收紧 SQL 侧硬筛（提高 rpsMin/amountMin）或扩 LIMIT（成本=enrich 耗时）。');
    }

    // L2 enrich 技术硬筛（主因统计）
    const reasons = new Map<string, number>();
    const picks: NonNullable<ReturnType<typeof enrichWithReason>['pick']>[] = [];
    for (const c of candidates) {
      const { pick, reason } = enrichWithReason(c, preset);
      if (pick) picks.push(pick);
      else reasons.set(reason ?? '未知', (reasons.get(reason ?? '未知') ?? 0) + 1);
    }
    console.log(`L2 enrich 技术硬筛: ${candidates.length} → ${picks.length}（淘汰 ${candidates.length - picks.length}）`);
    if (reasons.size > 0) {
      const top = [...reasons.entries()].sort((a, b) => b[1] - a[1]);
      console.log(`  淘汰主因: ${top.map(([r, n]) => `${r}×${n}`).join('、')}`);
    }

    if (picks.length === 0) { console.log('  ⚠ enrich 后无候选，后续层级无意义'); continue; }

    // L3 因子打分分布
    computeScreenScores(picks, preset);
    const scores = picks.map((p) => p.screenScore).sort((a, b) => a - b);
    const p50 = scores[Math.floor(scores.length / 2)];
    const ge60 = scores.filter((s) => s >= 60).length;
    console.log(`L3 因子打分: 中位 ${p50.toFixed(1)}，≥60 分 ${ge60} 只，最高 ${scores[scores.length - 1].toFixed(1)}`);

    // L4 风险层（veto 关闭，与线上一致只扣分）
    const before = picks.map((p) => ({ code: p.tsCode, score: p.finalScore }));
    void before;
    applyRiskOverlay(picks, preset);
    const levelCount = { low: 0, medium: 0, high: 0 };
    const flagCount = new Map<string, number>();
    let penalized = 0;
    for (const p of picks) {
      levelCount[p.riskLevel as keyof typeof levelCount]++;
      if (p.riskPenalty > 0) penalized++;
      for (const f of p.riskFlags) flagCount.set(f, (flagCount.get(f) ?? 0) + 1);
    }
    console.log(`L4 风险层: 扣分 ${penalized}/${picks.length}（高危 ${levelCount.high} / 中危 ${levelCount.medium}）`);
    if (flagCount.size > 0) {
      const top = [...flagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
      console.log(`  风险标签 Top: ${top.map(([f, n]) => `${f}×${n}`).join('、')}`);
    }

    // L5 截取
    const selected = picks.filter((p) => p.finalScore > 0).sort((a, b) => b.finalScore - a.finalScore).slice(0, preset.maxOutput);
    console.log(`L5 截取 top-${preset.maxOutput}: 入选 ${selected.length}，入选线 finalScore ≈ ${selected.length ? selected[selected.length - 1].finalScore.toFixed(1) : '--'}`);

    // 瓶颈诊断（专家规则，宁多报勿漏报）
    const hints: string[] = [];
    if (candidates.length < 50) hints.push('SQL 池偏浅（<50）：硬筛可能过严，或市场处于弱势期满足条件的票本来就少');
    if (picks.length / candidates.length < 0.3) hints.push('enrich 淘汰率 >70%：技术硬筛（量比/波动/回撤/MA）是主要瓶颈，考虑放宽或下移为因子');
    if (levelCount.high / picks.length > 0.3) hints.push('高危占比 >30%：风险层扣分在主导排序，因子区分度被淹没');
    if (hints.length) console.log(`  诊断: ${hints.join('；')}`);
  }

  // ── DB 侧：近 10 次 run 概览 ─────────────────────────────────────
  console.log('\n========== 近 10 次 run 概览（DB） ==========');
  const runs = await prisma.aiScreenRun.findMany({
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      strategyId: true, barDate: true, candidateCount: true, pickCount: true,
      llmReranked: true, llmCoverage: true, degradation: true,
    },
  });
  for (const r of runs) {
    console.log(`  ${r.barDate} ${r.strategyId.padEnd(10)} 候选${String(r.candidateCount).padStart(4)}→入选${String(r.pickCount).padStart(3)}  LLM覆盖${r.llmCoverage != null ? `${(r.llmCoverage * 100).toFixed(0)}%` : '--'}${r.degradation.length ? `  降级:${r.degradation.join(',')}` : ''}`);
  }

  // ── DB 侧：近 30 日入选 pick 的风险标签分布 ──────────────────────
  const since = new Date();
  since.setDate(since.getDate() - 30);
  const sinceStr = since.toISOString().slice(0, 10).replace(/-/g, '');
  const selectedPicks = await prisma.aiScreenPick.findMany({
    where: { selected: true, entryDate: { gte: sinceStr } },
    select: { riskFlags: true, riskLevel: true },
  });
  const rf = new Map<string, number>();
  const lv = new Map<string, number>();
  for (const p of selectedPicks) {
    lv.set(p.riskLevel ?? '?', (lv.get(p.riskLevel ?? '?') ?? 0) + 1);
    for (const f of p.riskFlags) rf.set(f, (rf.get(f) ?? 0) + 1);
  }
  console.log(`\n========== 近 30 日入选 pick（${selectedPicks.length} 条）风险画像 ==========`);
  console.log(`  风险等级: ${[...lv.entries()].map(([k, v]) => `${k}×${v}`).join('、') || '无'}`);
  const topRf = [...rf.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (topRf.length) console.log(`  标签 Top10: ${topRf.map(([f, n]) => `${f}×${n}`).join('、')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
