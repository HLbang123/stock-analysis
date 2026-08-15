/**
 * T+N 回测评算回填脚本
 *
 * 对每个有 entryDate 的候选(含未入选),按 N=1/5/20 算:
 *   - exitPrice / exitDate / returnPct(主口径 T+5 绝对收益>0)
 *   - shape_status(breakout/pullback 分类)
 *   - max_drawdown_pct / max_runup_pct(路径内 low.min/high.max 相对 entry)
 * 写入 ai_screen_evals(每 pick × 每 N 一行,upsert 幂等)。
 *
 * 交易日序列直接取自 daily_bars 的 distinct tradeDate(真实已同步数据,不依赖 Tushare 交易日历)。
 * 目标日不足(数据未到)→ 跳过,下次再跑。
 *
 * 用法:
 *   npx tsx scripts/backfill-ai-screen-eval.ts                # 全量,3 个持有期
 *   npx tsx scripts/backfill-ai-screen-eval.ts --N=5           # 仅 T+5
 *   npx tsx scripts/backfill-ai-screen-eval.ts --since=20260101
 */

import { prisma } from '../lib/db';

const NS = [1, 5, 20];
const FOLLOW_THROUGH_PCT = 3.0;
const FAILED_BREAKOUT_PCT = -3.0;
const COST_BPS = 0.0;

interface PickRow {
  id: string;
  tsCode: string;
  entryPrice: number | null;
  entryDate: string | null;
  breakout20dPct: number | null;
  pullbackToMa20Pct: number | null;
}

function classifyShape(
  breakout20dPct: number | null,
  pullbackToMa20Pct: number | null,
  returnPct: number | null,
): { status: string; tags: string[] } {
  const tags: string[] = [];
  let status = '';
  if (breakout20dPct != null && breakout20dPct >= -1.5) {
    tags.push('breakout_setup');
    if (returnPct == null) status = 'breakout_pending';
    else if (returnPct >= FOLLOW_THROUGH_PCT) status = 'breakout_follow_through';
    else if (returnPct <= FAILED_BREAKOUT_PCT) status = 'failed_breakout';
    else status = 'breakout_unconfirmed';
  }
  if (pullbackToMa20Pct != null && pullbackToMa20Pct >= -3 && pullbackToMa20Pct <= 6) {
    tags.push('ma20_pullback_setup');
    if (!status) {
      if (returnPct == null) status = 'pullback_pending';
      else if (returnPct > 0) status = 'pullback_rebound';
      else status = 'pullback_failed';
    }
  }
  return { status, tags };
}

async function main() {
  const argN = process.argv.find((a) => a.startsWith('--N='));
  const ns = argN ? [parseInt(argN.slice(4), 10)].filter((n) => NS.includes(n)) : NS;
  const sinceArg = process.argv.find((a) => a.startsWith('--since='));
  const since = sinceArg ? sinceArg.slice(8) : null;

  // 交易日序列(全市场 distinct tradeDate,升序)
  const days = await prisma.$queryRawUnsafe<{ tradeDate: string }[]>(
    `SELECT DISTINCT "tradeDate" FROM daily_bars ORDER BY "tradeDate" ASC`
  );
  const sortedDays = days.map((d) => d.tradeDate);
  const dayIndex = new Map<string, number>();
  sortedDays.forEach((d, i) => dayIndex.set(d, i));
  console.log(`[backfill-eval] 交易日序列 ${sortedDays.length} 天,首 ${sortedDays[0]} 末 ${sortedDays[sortedDays.length - 1]}`);

  // 待回填 picks
  const where: any = { entryDate: { not: null }, entryPrice: { not: null } };
  if (since) where.entryDate = { gte: since };
  const picks = await prisma.aiScreenPick.findMany({
    where,
    select: { id: true, tsCode: true, entryPrice: true, entryDate: true, breakout20dPct: true, pullbackToMa20Pct: true },
  });
  console.log(`[backfill-eval] 候选 picks ${picks.length} 条(持有期 ${ns.join('/')})`);

  // 已有 eval(跳过已算的)
  const pickIds = picks.map((p) => p.id);
  const existing = await prisma.aiScreenEval.findMany({
    where: { pickId: { in: pickIds } },
    select: { pickId: true, nDays: true },
  });
  const done = new Set(existing.map((e) => `${e.pickId}|${e.nDays}`));
  console.log(`[backfill-eval] 已有 eval ${existing.length} 条,将跳过`);

  let computed = 0;
  let skipped = 0;
  let pending = 0; // 数据未到/停牌无 bar,下次再跑
  let i = 0;
  for (const p of picks) {
    i++;
    if (i % 100 === 0 || i === picks.length) console.log(`[backfill-eval] 进度 ${i}/${picks.length},已算 ${computed},跳过 ${skipped},待数据 ${pending}`);
    const entryPrice = p.entryPrice;
    const entryDate = p.entryDate!;
    if (!entryPrice || entryPrice <= 0) { pending++; continue; }
    const entryIdx = dayIndex.get(entryDate);
    if (entryIdx == null) { pending++; continue; }

    for (const n of ns) {
      if (done.has(`${p.id}|${n}`)) { skipped++; continue; }
      const targetIdx = entryIdx + n;
      if (targetIdx >= sortedDays.length) { pending++; continue; } // 数据未到,下次再跑
      const exitDate = sortedDays[targetIdx];

      // 路径:entry 后到 exit 的所有日线(含 exit),算 exit 收益 + 回撤/涨幅
      const bars = await prisma.dailyBar.findMany({
        where: { tsCode: p.tsCode, tradeDate: { gt: entryDate, lte: exitDate } },
        orderBy: { tradeDate: 'asc' },
        select: { close: true, high: true, low: true },
      });
      const exitBar = bars.length > 0 ? bars[bars.length - 1] : null;
      if (!exitBar || exitBar.close == null) { pending++; continue; } // 该股停牌等无数据

      const exitPrice = exitBar.close;
      const returnPct = (exitPrice / entryPrice - 1) * 100 - COST_BPS / 100;
      const highs = bars.map((b) => b.high).filter((v): v is number => v != null);
      const lows = bars.map((b) => b.low).filter((v): v is number => v != null);
      const maxRunup = highs.length ? (Math.max(...highs) / entryPrice - 1) * 100 : null;
      const maxDrawdown = lows.length ? (Math.min(...lows) / entryPrice - 1) * 100 : null;
      const shape = classifyShape(p.breakout20dPct, p.pullbackToMa20Pct, returnPct);

      await prisma.aiScreenEval.upsert({
        where: { pickId_nDays: { pickId: p.id, nDays: n } },
        create: {
          pickId: p.id,
          nDays: n,
          exitPrice,
          exitDate,
          returnPct: Math.round(returnPct * 10000) / 10000,
          costBps: COST_BPS,
          shapeStatus: shape.status || null,
          maxDrawdownPct: maxDrawdown != null ? Math.round(Math.min(maxDrawdown, 0) * 10000) / 10000 : null,
          maxRunupPct: maxRunup != null ? Math.round(Math.max(maxRunup, 0) * 10000) / 10000 : null,
          pathStatus: 'ok',
        },
        update: {
          exitPrice,
          exitDate,
          returnPct: Math.round(returnPct * 10000) / 10000,
          shapeStatus: shape.status || null,
          maxDrawdownPct: maxDrawdown != null ? Math.round(Math.min(maxDrawdown, 0) * 10000) / 10000 : null,
          maxRunupPct: maxRunup != null ? Math.round(Math.max(maxRunup, 0) * 10000) / 10000 : null,
          pathStatus: 'ok',
        },
      });
      computed++;
    }
  }

  console.log(`[backfill-eval] 完成。新算 ${computed},跳过 ${skipped},待数据 ${pending}`);
}

main()
  .catch((e) => {
    console.error('[backfill-eval] 失败:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
