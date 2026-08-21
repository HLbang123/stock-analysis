/**
 * T+N 回测评算回填脚本
 *
 * 对每个有 entryDate 的候选(含未入选),按 N=1/5/20 算:
 *   - exitPrice / exitDate / returnPct(主口径 T+5 绝对收益>0)
 *   - shape_status(breakout/pullback 分类)
 *   - max_drawdown_pct / max_runup_pct(路径内 low.min/high.max 相对 entry)
 * 写入 ai_screen_evals(每 pick × 每 N 一行,upsert 幂等)。
 *
 * 性能口径（2026-08-19，daily_bars 千万级）：
 * - 交易日历改用递归 CTE 松散索引扫描（同 compute-rps），取代 DISTINCT 全表扫
 * - 取数批量：收集 (tsCode, tradeDate) 路径对 → 5000/批 IN 精确查（取代逐条 findMany）
 * - 落库批量：500/批单事务 upsert（取代逐条 upsert）
 * - 默认只回填近 60 天（覆盖 T+20 约 35 日历日跨度 + 断跑缓冲）；全量历史回补用 --since=20160101
 *
 * 用法:
 *   npx tsx scripts/backfill-ai-screen-eval.ts                   # 增量(近60天)
 *   npx tsx scripts/backfill-ai-screen-eval.ts --N=5              # 仅 T+5
 *   npx tsx scripts/backfill-ai-screen-eval.ts --since=20160101   # 全量历史回补
 */

import { prisma } from '../lib/db';

const NS = [1, 5, 20];
const FOLLOW_THROUGH_PCT = 3.0;
const FAILED_BREAKOUT_PCT = -3.0;
const COST_BPS = 0.0;
const PICK_BATCH = 2000; // 每批 pick 数（限内存）
const PAIR_CHUNK = 5000; // 每批 IN 对数量（低于 PG 参数上限）
const WRITE_BATCH = 500; // 每批 upsert 行数（单事务）

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

/** 默认回填窗口：今天往前 60 日历日，YYYYMMDD（覆盖 T+20 约 35 日历日 + 断跑缓冲） */
function defaultSince(): string {
  const d = new Date();
  d.setDate(d.getDate() - 60);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

/** 交易日历：递归 CTE 松散索引扫描（升序返回），取代 DISTINCT 全表扫 */
async function loadCalendar(): Promise<{ sortedDays: string[]; dayIndex: Map<string, number> }> {
  const rows = await prisma.$queryRawUnsafe<{ d: string }[]>(`
    WITH RECURSIVE dates AS (
      (SELECT "tradeDate" AS d FROM daily_bars ORDER BY "tradeDate" DESC LIMIT 1)
      UNION ALL
      SELECT (SELECT "tradeDate" FROM daily_bars WHERE "tradeDate" < dates.d ORDER BY "tradeDate" DESC LIMIT 1)
      FROM dates
      WHERE dates.d IS NOT NULL
    )
    SELECT d FROM dates WHERE d IS NOT NULL LIMIT 4000
  `);
  const sortedDays = rows.map((r) => r.d).reverse();
  const dayIndex = new Map<string, number>();
  sortedDays.forEach((d, i) => dayIndex.set(d, i));
  return { sortedDays, dayIndex };
}

async function main() {
  const argN = process.argv.find((a) => a.startsWith('--N='));
  const ns = argN ? [parseInt(argN.slice(4), 10)].filter((n) => NS.includes(n)) : NS;
  const sinceArg = process.argv.find((a) => a.startsWith('--since='));
  const since = sinceArg ? sinceArg.slice(8) : defaultSince();

  const { sortedDays, dayIndex } = await loadCalendar();
  console.log(`[backfill-eval] 交易日序列 ${sortedDays.length} 天,首 ${sortedDays[0]} 末 ${sortedDays[sortedDays.length - 1]}`);

  // 待回填 picks（默认近 60 天，全量用 --since=20160101）
  const picks = await prisma.aiScreenPick.findMany({
    where: { entryDate: { gte: since }, entryPrice: { not: null } },
    select: { id: true, tsCode: true, entryPrice: true, entryDate: true, breakout20dPct: true, pullbackToMa20Pct: true },
  });
  console.log(`[backfill-eval] 候选 picks ${picks.length} 条(entryDate>=${since},持有期 ${ns.join('/')})`);

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

  for (let b0 = 0; b0 < picks.length; b0 += PICK_BATCH) {
    const batch = picks.slice(b0, b0 + PICK_BATCH);

    // 1. 收集本批需要的 (tsCode, tradeDate) 路径对 + 可算任务
    const pairSet = new Set<string>();
    const tasks: { pick: PickRow; n: number; entryIdx: number; targetIdx: number }[] = [];
    for (const p of batch) {
      const entryPrice = p.entryPrice;
      const entryDate = p.entryDate!;
      if (!entryPrice || entryPrice <= 0) { pending++; continue; }
      const entryIdx = dayIndex.get(entryDate);
      if (entryIdx == null) { pending++; continue; }
      for (const n of ns) {
        if (done.has(`${p.id}|${n}`)) { skipped++; continue; }
        const targetIdx = entryIdx + n;
        if (targetIdx >= sortedDays.length) { pending++; continue; } // 数据未到,下次再跑
        tasks.push({ pick: p, n, entryIdx, targetIdx });
        for (let j = entryIdx + 1; j <= targetIdx; j++) pairSet.add(`${p.tsCode}|${sortedDays[j]}`);
      }
    }

    // 2. 分块按 PK (tsCode, tradeDate) 精确取 close/high/low
    const pairs = [...pairSet].map((s) => s.split('|') as [string, string]);
    const barBy = new Map<string, { close: number; high: number; low: number }>();
    for (let i = 0; i < pairs.length; i += PAIR_CHUNK) {
      const chunk = pairs.slice(i, i + PAIR_CHUNK);
      const placeholders = chunk.map((_, j) => `($${j * 2 + 1}, $${j * 2 + 2})`).join(',');
      const rows = await prisma.$queryRawUnsafe<
        { tsCode: string; tradeDate: string; close: number | null; high: number | null; low: number | null }[]
      >(
        `SELECT "tsCode", "tradeDate", close, high, low FROM daily_bars WHERE ("tsCode", "tradeDate") IN (${placeholders})`,
        ...chunk.flat()
      );
      for (const r of rows) {
        if (r.close == null) continue;
        barBy.set(`${r.tsCode}|${r.tradeDate}`, { close: r.close, high: r.high ?? r.close, low: r.low ?? r.close });
      }
    }

    // 3. 重建路径(entry 后到 target 的交易日,停牌日无 bar 自然跳过)→ 算收益/回撤/涨幅
    const toApply: {
      id: string; n: number; exitDate: string; exitPrice: number; returnPct: number;
      status: string; maxDrawdownPct: number | null; maxRunupPct: number | null;
    }[] = [];
    for (const t of tasks) {
      const p = t.pick;
      const entryPrice = p.entryPrice!;
      let exitPrice: number | null = null;
      const highs: number[] = [];
      const lows: number[] = [];
      for (let j = t.entryIdx + 1; j <= t.targetIdx; j++) {
        const b = barBy.get(`${p.tsCode}|${sortedDays[j]}`);
        if (b) { exitPrice = b.close; highs.push(b.high); lows.push(b.low); }
      }
      if (exitPrice == null) { pending++; continue; } // 该股停牌等无数据
      const returnPct = (exitPrice / entryPrice - 1) * 100 - COST_BPS / 100;
      const maxRunup = highs.length ? (Math.max(...highs) / entryPrice - 1) * 100 : null;
      const maxDrawdown = lows.length ? (Math.min(...lows) / entryPrice - 1) * 100 : null;
      const shape = classifyShape(p.breakout20dPct, p.pullbackToMa20Pct, returnPct);
      toApply.push({
        id: p.id, n: t.n, exitDate: sortedDays[t.targetIdx], exitPrice,
        returnPct, status: shape.status,
        maxDrawdownPct: maxDrawdown != null ? Math.round(Math.min(maxDrawdown, 0) * 10000) / 10000 : null,
        maxRunupPct: maxRunup != null ? Math.round(Math.max(maxRunup, 0) * 10000) / 10000 : null,
      });
    }

    // 4. 批量 upsert(500/批单事务)
    for (let i = 0; i < toApply.length; i += WRITE_BATCH) {
      const chunk = toApply.slice(i, i + WRITE_BATCH);
      await prisma.$transaction(
        chunk.map((u) =>
          prisma.aiScreenEval.upsert({
            where: { pickId_nDays: { pickId: u.id, nDays: u.n } },
            create: {
              pickId: u.id, nDays: u.n,
              exitPrice: u.exitPrice, exitDate: u.exitDate,
              returnPct: Math.round(u.returnPct * 10000) / 10000,
              costBps: COST_BPS,
              shapeStatus: u.status || null,
              maxDrawdownPct: u.maxDrawdownPct, maxRunupPct: u.maxRunupPct,
              pathStatus: 'ok',
            },
            update: {
              exitPrice: u.exitPrice, exitDate: u.exitDate,
              returnPct: Math.round(u.returnPct * 10000) / 10000,
              shapeStatus: u.status || null,
              maxDrawdownPct: u.maxDrawdownPct, maxRunupPct: u.maxRunupPct,
              pathStatus: 'ok',
            },
          })
        )
      );
    }
    computed += toApply.length;
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
