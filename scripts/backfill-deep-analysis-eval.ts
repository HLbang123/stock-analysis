/**
 * 深度分析 T+N 回测回填脚本
 *
 * 对每条 DeepAnalysisRecord，按 N=5/10/20 算：
 *   - exitPrice / exitDate / returnPct（基于 entryDate 当天收盘价标准化，保证同股同天可比）
 *   - max_drawdown_pct / max_runup_pct（路径内 low.min/high.max 相对 entryClose）
 * 写入 deep_analysis_evals（每 record × 每 N 一行，upsert 幂等）。
 *
 * 交易日序列取自 daily_bars distinct tradeDate。目标日不足（数据未到）→ 跳过下次再跑。
 * 已算的 eval 跳过（T+N 固定，不变）。
 *
 * 用法：
 *   npx tsx scripts/backfill-deep-analysis-eval.ts           # 全量 5/10/20
 *   npx tsx scripts/backfill-deep-analysis-eval.ts --N=5
 *   npx tsx scripts/backfill-deep-analysis-eval.ts --since=20260101
 */

import { prisma } from '../lib/db';

const NS = [5, 10, 20];
const COST_BPS = 0.0;

/** entryDate 不在交易日序列时，向前找最近的交易日 */
function findPrevTradeDay(entryDate: string, dayIndex: Map<string, number>): number | null {
  if (dayIndex.has(entryDate)) return dayIndex.get(entryDate)!;
  let d = entryDate;
  while (d > '20200101') {
    const y = parseInt(d.slice(0, 4), 10);
    const m = parseInt(d.slice(4, 6), 10) - 1;
    const day = parseInt(d.slice(6, 8), 10);
    const dt = new Date(y, m, day);
    dt.setDate(dt.getDate() - 1);
    d = `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, '0')}${String(dt.getDate()).padStart(2, '0')}`;
    if (dayIndex.has(d)) return dayIndex.get(d)!;
  }
  return null;
}

/** sina 格式(sz002415/sh600664) → Tushare 格式(002415.SZ/600664.SH)；已 Tushare 格式原样返回。
 *  record.stockCode 来自前端(sina 口径)，daily_bars.tsCode 是 Tushare 口径——不转换永远查不到 → 全"待数据" */
function toTushareCode(c: string): string {
  const m = c.match(/^([a-z]{2})(\d{6})$/i);
  return m ? `${m[2]}.${m[1].toUpperCase()}` : c;
}

async function main() {
  const argN = process.argv.find((a) => a.startsWith('--N='));
  const ns = argN ? [parseInt(argN.slice(4), 10)].filter((n) => NS.includes(n)) : NS;
  const sinceArg = process.argv.find((a) => a.startsWith('--since='));
  const since = sinceArg ? sinceArg.slice(8) : null;

  const days = await prisma.$queryRawUnsafe<{ tradeDate: string }[]>(
    `SELECT DISTINCT "tradeDate" FROM daily_bars ORDER BY "tradeDate" ASC`
  );
  const sortedDays = days.map((d) => d.tradeDate);
  const dayIndex = new Map<string, number>();
  sortedDays.forEach((d, i) => dayIndex.set(d, i));
  console.log(`[backfill-deep-eval] 交易日序列 ${sortedDays.length} 天，首 ${sortedDays[0]} 末 ${sortedDays[sortedDays.length - 1]}`);

  const where: any = {};
  if (since) where.entryDate = { gte: since };
  const records = await prisma.deepAnalysisRecord.findMany({
    where,
    include: { evals: { select: { nDays: true } } },
  });
  console.log(`[backfill-deep-eval] records ${records.length} 条（持有期 ${ns.join('/')}）`);

  const done = new Set<string>();
  records.forEach((r) => r.evals.forEach((e) => done.add(`${r.id}|${e.nDays}`)));
  console.log(`[backfill-deep-eval] 已有 eval ${done.size} 条，将跳过`);

  let computed = 0, skipped = 0, pending = 0;
  let i = 0;
  for (const r of records) {
    i++;
    if (i % 50 === 0 || i === records.length) {
      console.log(`[backfill-deep-eval] 进度 ${i}/${records.length}，已算 ${computed}，跳过 ${skipped}，待数据 ${pending}`);
    }

    const entryIdx = findPrevTradeDay(r.entryDate, dayIndex);
    if (entryIdx == null) { pending++; continue; }

    // entryClose：entryDate 当天收盘（标准化基准，不用用户实时价）
    const tushareCode = toTushareCode(r.stockCode);
    const entryBar = await prisma.dailyBar.findFirst({
      where: { tsCode: tushareCode, tradeDate: sortedDays[entryIdx] },
      select: { close: true },
    });
    if (!entryBar || entryBar.close == null || entryBar.close <= 0) { pending++; continue; }
    const entryClose = entryBar.close;

    for (const n of ns) {
      if (done.has(`${r.id}|${n}`)) { skipped++; continue; }
      const targetIdx = entryIdx + n;
      if (targetIdx >= sortedDays.length) { pending++; continue; }
      const exitDate = sortedDays[targetIdx];

      const bars = await prisma.dailyBar.findMany({
        where: { tsCode: tushareCode, tradeDate: { gt: sortedDays[entryIdx], lte: exitDate } },
        orderBy: { tradeDate: 'asc' },
        select: { close: true, high: true, low: true },
      });
      const exitBar = bars.length > 0 ? bars[bars.length - 1] : null;
      if (!exitBar || exitBar.close == null) { pending++; continue; }

      const exitPrice = exitBar.close;
      const returnPct = (exitPrice / entryClose - 1) * 100 - COST_BPS / 100;
      const highs = bars.map((b) => b.high).filter((v): v is number => v != null);
      const lows = bars.map((b) => b.low).filter((v): v is number => v != null);
      const maxRunup = highs.length ? (Math.max(...highs) / entryClose - 1) * 100 : null;
      const maxDrawdown = lows.length ? (Math.min(...lows) / entryClose - 1) * 100 : null;

      await prisma.deepAnalysisEval.upsert({
        where: { recordId_nDays: { recordId: r.id, nDays: n } },
        create: {
          recordId: r.id, nDays: n,
          exitPrice, exitDate,
          returnPct: Math.round(returnPct * 10000) / 10000,
          maxDrawdownPct: maxDrawdown != null ? Math.round(Math.min(maxDrawdown, 0) * 10000) / 10000 : null,
          maxRunupPct: maxRunup != null ? Math.round(Math.max(maxRunup, 0) * 10000) / 10000 : null,
          pathStatus: 'ok',
        },
        update: {
          exitPrice, exitDate,
          returnPct: Math.round(returnPct * 10000) / 10000,
          maxDrawdownPct: maxDrawdown != null ? Math.round(Math.min(maxDrawdown, 0) * 10000) / 10000 : null,
          maxRunupPct: maxRunup != null ? Math.round(Math.max(maxRunup, 0) * 10000) / 10000 : null,
          pathStatus: 'ok',
        },
      });
      computed++;
    }
  }

  console.log(`[backfill-deep-eval] 完成。新算 ${computed}，跳过 ${skipped}，待数据 ${pending}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
