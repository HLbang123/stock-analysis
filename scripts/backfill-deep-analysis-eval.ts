/**
 * 深度分析 T+N 回测回填脚本
 *
 * 对每条 DeepAnalysisRecord，按 N=5/10/20 算：
 *   - exitPrice / exitDate / returnPct（基于 entryDate 当天收盘价标准化，保证同股同天可比）
 *   - max_drawdown_pct / max_runup_pct（路径内 low.min/high.max 相对 entryClose）
 * 写入 deep_analysis_evals（每 record × 每 N 一行，upsert 幂等）。
 *
 * 性能口径（2026-08-19，daily_bars 千万级）：
 * - 交易日历改用递归 CTE 松散索引扫描（同 compute-rps），取代 DISTINCT 全表扫
 * - 取数批量：收集 (tsCode, tradeDate) 对（entry 收盘 + 各 N 路径）→ 5000/批 IN 精确查
 * - 落库批量：500/批单事务 upsert（取代逐条 upsert）
 * - 默认只回填近 60 天（覆盖 T+20 约 35 日历日跨度 + 断跑缓冲）；全量历史回补用 --since=20160101
 *
 * 用法：
 *   npx tsx scripts/backfill-deep-analysis-eval.ts                   # 增量(近60天)
 *   npx tsx scripts/backfill-deep-analysis-eval.ts --N=5
 *   npx tsx scripts/backfill-deep-analysis-eval.ts --since=20160101  # 全量历史回补
 */

import { prisma } from '../lib/db';

const NS = [5, 10, 20];
const COST_BPS = 0.0;
const RECORD_BATCH = 2000; // 每批 record 数（限内存）
const PAIR_CHUNK = 5000;   // 每批 IN 对数量（低于 PG 参数上限）
const WRITE_BATCH = 500;   // 每批 upsert 行数（单事务）

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

/** 默认回填窗口：今天往前 60 日历日，YYYYMMDD */
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
  console.log(`[backfill-deep-eval] 交易日序列 ${sortedDays.length} 天，首 ${sortedDays[0]} 末 ${sortedDays[sortedDays.length - 1]}`);

  // 待回填 records（默认近 60 天，全量用 --since=20160101）
  const records = await prisma.deepAnalysisRecord.findMany({
    where: { entryDate: { gte: since } },
    include: { evals: { select: { nDays: true } } },
  });
  console.log(`[backfill-deep-eval] records ${records.length} 条(entryDate>=${since},持有期 ${ns.join('/')})`);

  const done = new Set<string>();
  records.forEach((r) => r.evals.forEach((e) => done.add(`${r.id}|${e.nDays}`)));
  console.log(`[backfill-deep-eval] 已有 eval ${done.size} 条，将跳过`);

  let computed = 0, skipped = 0, pending = 0;

  for (let b0 = 0; b0 < records.length; b0 += RECORD_BATCH) {
    const batch = records.slice(b0, b0 + RECORD_BATCH);

    // 1. 收集本批需要的 (tsCode, tradeDate) 对：entry 收盘 + 各 N 路径
    const pairSet = new Set<string>();
    const tasks: { recordId: string; tushareCode: string; n: number; entryIdx: number; targetIdx: number }[] = [];
    for (const r of batch) {
      const entryIdx = findPrevTradeDay(r.entryDate, dayIndex);
      if (entryIdx == null) { pending++; continue; }
      const tushareCode = toTushareCode(r.stockCode);
      pairSet.add(`${tushareCode}|${sortedDays[entryIdx]}`);
      for (const n of ns) {
        if (done.has(`${r.id}|${n}`)) { skipped++; continue; }
        const targetIdx = entryIdx + n;
        if (targetIdx >= sortedDays.length) { pending++; continue; }
        tasks.push({ recordId: r.id, tushareCode, n, entryIdx, targetIdx });
        for (let j = entryIdx + 1; j <= targetIdx; j++) pairSet.add(`${tushareCode}|${sortedDays[j]}`);
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

    // 3. 计算：entry 收盘标准化 + 路径收益/回撤/涨幅
    const toApply: {
      recordId: string; n: number; exitDate: string; exitPrice: number; returnPct: number;
      maxDrawdownPct: number | null; maxRunupPct: number | null;
    }[] = [];
    for (const t of tasks) {
      const entryBar = barBy.get(`${t.tushareCode}|${sortedDays[t.entryIdx]}`);
      if (!entryBar || entryBar.close <= 0) { pending++; continue; }
      const entryClose = entryBar.close;
      let exitPrice: number | null = null;
      const highs: number[] = [];
      const lows: number[] = [];
      for (let j = t.entryIdx + 1; j <= t.targetIdx; j++) {
        const b = barBy.get(`${t.tushareCode}|${sortedDays[j]}`);
        if (b) { exitPrice = b.close; highs.push(b.high); lows.push(b.low); }
      }
      if (exitPrice == null) { pending++; continue; } // 停牌等无数据
      const returnPct = (exitPrice / entryClose - 1) * 100 - COST_BPS / 100;
      const maxRunup = highs.length ? (Math.max(...highs) / entryClose - 1) * 100 : null;
      const maxDrawdown = lows.length ? (Math.min(...lows) / entryClose - 1) * 100 : null;
      toApply.push({
        recordId: t.recordId, n: t.n, exitDate: sortedDays[t.targetIdx], exitPrice,
        returnPct,
        maxDrawdownPct: maxDrawdown != null ? Math.round(Math.min(maxDrawdown, 0) * 10000) / 10000 : null,
        maxRunupPct: maxRunup != null ? Math.round(Math.max(maxRunup, 0) * 10000) / 10000 : null,
      });
    }

    // 4. 批量 upsert(500/批单事务)
    for (let i = 0; i < toApply.length; i += WRITE_BATCH) {
      const chunk = toApply.slice(i, i + WRITE_BATCH);
      await prisma.$transaction(
        chunk.map((u) =>
          prisma.deepAnalysisEval.upsert({
            where: { recordId_nDays: { recordId: u.recordId, nDays: u.n } },
            create: {
              recordId: u.recordId, nDays: u.n,
              exitPrice: u.exitPrice, exitDate: u.exitDate,
              returnPct: Math.round(u.returnPct * 10000) / 10000,
              maxDrawdownPct: u.maxDrawdownPct, maxRunupPct: u.maxRunupPct,
              pathStatus: 'ok',
            },
            update: {
              exitPrice: u.exitPrice, exitDate: u.exitDate,
              returnPct: Math.round(u.returnPct * 10000) / 10000,
              maxDrawdownPct: u.maxDrawdownPct, maxRunupPct: u.maxRunupPct,
              pathStatus: 'ok',
            },
          })
        )
      );
    }
    computed += toApply.length;
  }

  console.log(`[backfill-deep-eval] 完成。新算 ${computed}，跳过 ${skipped}，待数据 ${pending}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
