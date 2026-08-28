/**
 * 短线策略 — T+N 回测回填与统计读取（raw SQL 表 short_term_evals）
 *
 * 口径与 AiScreenEval 对齐：以 matched_date 当日收盘价为 entryPrice，
 * 持有 N 个交易日后取该日收盘价为 exitPrice，returnPct = (exit/entry - 1) * 100。
 * N ∈ [1,5,20]，主口径 T+5。
 */

import { prisma } from "@/lib/db";

export const SHORT_TERM_EVALS_DDL = [
  "CREATE TABLE IF NOT EXISTS short_term_evals (" +
    "signal_id VARCHAR(36) NOT NULL," +
    "n_days INTEGER NOT NULL," +
    "exit_date VARCHAR(10)," +
    "exit_price DOUBLE PRECISION," +
    "return_pct DOUBLE PRECISION," +
    "max_runup_pct DOUBLE PRECISION," +
    "max_drawdown_pct DOUBLE PRECISION," +
    "created_at VARCHAR(32) NOT NULL," +
    "PRIMARY KEY (signal_id, n_days))",
  "CREATE INDEX IF NOT EXISTS idx_short_term_evals_signal ON short_term_evals (signal_id)",
];

export async function ensureShortTermEvalTable(): Promise<void> {
  for (const sql of SHORT_TERM_EVALS_DDL) await prisma.$executeRawUnsafe(sql);
}

const NS = [1, 5, 20];
const PAIR_CHUNK = 5000;
const WRITE_BATCH = 500;

function defaultSince(): string {
  const d = new Date();
  d.setDate(d.getDate() - 120);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

function ymd8(ymd: string): string {
  return ymd && ymd.length === 10 ? ymd.replace(/-/g, "") : ymd;
}

interface SignalRow {
  id: string;
  tsCode: string;
  matchedDate: string;
  strategy: string;
  signalType: string;
}

interface BarPoint { close: number; high: number; low: number }

/** 交易日历：递归 CTE 松散索引扫描（升序返回） */
async function loadCalendar(): Promise<{ sortedDays: string[]; dayIndex: Map<string, number> }> {
  const rows = await prisma.$queryRawUnsafe<{ d: string }[]>(
    `WITH RECURSIVE dates AS (
      (SELECT "tradeDate" AS d FROM daily_bars ORDER BY "tradeDate" DESC LIMIT 1)
      UNION ALL
      SELECT (SELECT "tradeDate" FROM daily_bars WHERE "tradeDate" < dates.d ORDER BY "tradeDate" DESC LIMIT 1)
      FROM dates WHERE dates.d IS NOT NULL
    )
    SELECT d FROM dates WHERE d IS NOT NULL LIMIT 4000`
  );
  const sortedDays = rows.map((r) => String(r.d)).reverse();
  const dayIndex = new Map<string, number>();
  sortedDays.forEach((d, i) => dayIndex.set(d, i));
  return { sortedDays, dayIndex };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function returnStats(returns: number[]) {
  const valid = returns.filter((r) => r != null && Number.isFinite(r));
  if (!valid.length) return { count: 0, winRate: null, avg: null, median: null };
  const wins = valid.filter((r) => r > 0).length;
  return {
    count: valid.length,
    winRate: Math.round((wins / valid.length) * 1000) / 10,
    avg: Math.round((mean(valid) ?? 0) * 10000) / 10000,
    median: Math.round((median(valid) ?? 0) * 10000) / 10000,
  };
}

export async function backfillShortTermEval(opts: { since?: string; ns?: number[] } = {}) {
  const ns = (opts.ns?.length ? opts.ns : NS).filter((n) => NS.includes(n));
  const since = opts.since ?? defaultSince();
  await ensureShortTermEvalTable();

  const { sortedDays, dayIndex } = await loadCalendar();
  console.log(`[backfill-short-term-eval] 交易日序列 ${sortedDays.length} 天, since=${since}, n=${ns.join("/")}`);

  const signals = await prisma.$queryRawUnsafe<SignalRow[]>(
    `SELECT id, ts_code AS "tsCode", matched_date AS "matchedDate", strategy, signal_type AS "signalType"
     FROM short_term_signals WHERE matched_date >= $1 ORDER BY matched_date, ts_code`,
    since
  );
  console.log(`[backfill-short-term-eval] 待回填信号 ${signals.length} 条`);
  if (!signals.length) return { signals: 0, computed: 0, skipped: 0, pending: 0 };

  const tasks: { sig: SignalRow; n: number; entryIdx: number; targetIdx: number }[] = [];
  const pairSet = new Set<string>();
  let pending = 0;
  for (const sig of signals) {
    const entryDate = ymd8(sig.matchedDate);
    const entryIdx = dayIndex.get(entryDate);
    if (entryIdx == null) { pending++; continue; }
    for (const n of ns) {
      const targetIdx = entryIdx + n;
      if (targetIdx >= sortedDays.length) { pending++; continue; }
      tasks.push({ sig, n, entryIdx, targetIdx });
      for (let j = entryIdx; j <= targetIdx; j++) pairSet.add(`${sig.tsCode}|${sortedDays[j]}`);
    }
  }

  const pairs = [...pairSet].map((s) => s.split("|") as [string, string]);
  const barBy = new Map<string, BarPoint>();
  for (let i = 0; i < pairs.length; i += PAIR_CHUNK) {
    const chunk = pairs.slice(i, i + PAIR_CHUNK);
    const placeholders = chunk.map((_, j) => `($${j * 2 + 1}, $${j * 2 + 2})`).join(",");
    const rows = await prisma.$queryRawUnsafe<{ tsCode: string; tradeDate: string; close: number | null; high: number | null; low: number | null }[]>
      (`SELECT "tsCode" AS "tsCode", "tradeDate" AS "tradeDate", close, high, low FROM daily_bars WHERE ("tsCode", "tradeDate") IN (${placeholders})`,
      ...chunk.flat());
    for (const r of rows) {
      if (r.close == null) continue;
      barBy.set(`${r.tsCode}|${r.tradeDate}`, { close: r.close, high: r.high ?? r.close, low: r.low ?? r.close });
    }
  }

  const toWrite: {
    signalId: string; n: number; exitDate: string; exitPrice: number; returnPct: number;
    maxRunupPct: number | null; maxDrawdownPct: number | null;
  }[] = [];
  for (const t of tasks) {
    const entryKey = `${t.sig.tsCode}|${sortedDays[t.entryIdx]}`;
    const entryBar = barBy.get(entryKey);
    const exitDate = sortedDays[t.targetIdx];
    const exitBar = barBy.get(`${t.sig.tsCode}|${exitDate}`);
    if (!entryBar || !exitBar || entryBar.close <= 0) { pending++; continue; }
    const returnPct = (exitBar.close / entryBar.close - 1) * 100;
    const highs: number[] = [];
    const lows: number[] = [];
    for (let j = t.entryIdx + 1; j <= t.targetIdx; j++) {
      const b = barBy.get(`${t.sig.tsCode}|${sortedDays[j]}`);
      if (b) { highs.push(b.high); lows.push(b.low); }
    }
    const maxRunup = highs.length ? (Math.max(...highs) / entryBar.close - 1) * 100 : null;
    const maxDrawdown = lows.length ? (Math.min(...lows) / entryBar.close - 1) * 100 : null;
    toWrite.push({
      signalId: t.sig.id,
      n: t.n,
      exitDate,
      exitPrice: Math.round(exitBar.close * 10000) / 10000,
      returnPct: Math.round(returnPct * 10000) / 10000,
      maxRunupPct: maxRunup != null ? Math.round(Math.max(maxRunup, 0) * 10000) / 10000 : null,
      maxDrawdownPct: maxDrawdown != null ? Math.round(Math.min(maxDrawdown, 0) * 10000) / 10000 : null,
    });
  }

  const upsert = `INSERT INTO short_term_evals
    (signal_id, n_days, exit_date, exit_price, return_pct, max_runup_pct, max_drawdown_pct, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (signal_id, n_days) DO UPDATE SET
      exit_date = EXCLUDED.exit_date,
      exit_price = EXCLUDED.exit_price,
      return_pct = EXCLUDED.return_pct,
      max_runup_pct = EXCLUDED.max_runup_pct,
      max_drawdown_pct = EXCLUDED.max_drawdown_pct,
      created_at = EXCLUDED.created_at`;
  const createdAt = new Date().toISOString();
  for (let i = 0; i < toWrite.length; i += WRITE_BATCH) {
    const chunk = toWrite.slice(i, i + WRITE_BATCH);
    await prisma.$transaction(
      chunk.map((u) =>
        prisma.$executeRawUnsafe(upsert, u.signalId, u.n, u.exitDate, u.exitPrice, u.returnPct, u.maxRunupPct, u.maxDrawdownPct, createdAt)
      )
    );
  }

  return { signals: signals.length, computed: toWrite.length, skipped: 0, pending };
}

const STRATEGY_NAMES: Record<string, string> = {
  "limit-up-three-yin": "涨停+三连阴",
  "dragon-first-yin": "龙首阴",
  "double-dragon": "双龙战法",
};

export async function loadShortTermStats() {
  await ensureShortTermEvalTable();
  const rows = await prisma.$queryRawUnsafe<{ strategy: string; nDays: number; returnPct: number }[]>(
    `SELECT s.strategy, e.n_days AS "nDays", e.return_pct AS "returnPct"
     FROM short_term_evals e
     JOIN short_term_signals s ON s.id = e.signal_id
     WHERE e.return_pct IS NOT NULL
     ORDER BY s.strategy, e.n_days`
  );

  const byStrategy = new Map<string, Map<number, number[]>>();
  for (const r of rows) {
    if (!byStrategy.has(r.strategy)) byStrategy.set(r.strategy, new Map());
    const byN = byStrategy.get(r.strategy)!;
    if (!byN.has(Number(r.nDays))) byN.set(Number(r.nDays), []);
    byN.get(Number(r.nDays))!.push(Number(r.returnPct));
  }

  const strategies = [...byStrategy.entries()].map(([sid, byN]) => {
    const byHoldingPeriod: Record<number, any> = {};
    for (const n of NS) byHoldingPeriod[n] = returnStats(byN.get(n) ?? []);
    const primary = byHoldingPeriod[5];
    return {
      strategyId: sid,
      strategyName: STRATEGY_NAMES[sid] ?? sid,
      evaluatedCount: primary.count,
      avgReturn: primary.avg,
      winRate: primary.winRate,
      byHoldingPeriod,
    };
  }).sort((a, b) => (b.evaluatedCount || 0) - (a.evaluatedCount || 0));

  const allReturns = rows
    .filter((r) => Number(r.nDays) === 5)
    .map((r) => Number(r.returnPct))
    .filter((r) => Number.isFinite(r));
  const summary = returnStats(allReturns);
  return { primaryN: 5, summary, strategies };
}