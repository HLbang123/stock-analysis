/**
 * 短线策略 — T+1 次日三档（开/高/收）回测回填与统计读取（raw SQL 表 short_term_evals）
 *
 * 口径：以 matched_date 当日收盘价为 entryPrice；
 * 次日（T+1）分别按 开盘价 / 最高价 / 收盘价 卖出，returnPct = (exit/entry - 1) * 100。
 * 主口径 = 次日最高价卖出（冲高卖、不格局）。
 */

import { prisma } from "@/lib/db";

export const SHORT_TERM_EVALS_DDL = [
  "CREATE TABLE IF NOT EXISTS short_term_evals (" +
    "signal_id VARCHAR(36) NOT NULL," +
    "exit_type VARCHAR(8) NOT NULL," +
    "exit_price DOUBLE PRECISION," +
    "return_pct DOUBLE PRECISION," +
    "created_at VARCHAR(32) NOT NULL," +
    "PRIMARY KEY (signal_id, exit_type))",
];

export async function ensureShortTermEvalTable(): Promise<void> {
  for (const sql of SHORT_TERM_EVALS_DDL) await prisma.$executeRawUnsafe(sql);
}

const EXIT_TYPES = ["open", "high", "low", "close"] as const;

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

interface BarPoint { open: number; high: number; low: number; close: number }

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

const PAIR_CHUNK = 5000;
const WRITE_BATCH = 500;

export async function backfillShortTermEval(opts: { since?: string } = {}) {
  const since = opts.since ?? defaultSince();
  await ensureShortTermEvalTable();

  const { sortedDays, dayIndex } = await loadCalendar();
  console.log(`[backfill-short-term-eval] 交易日序列 ${sortedDays.length} 天, since=${since}`);

  const signals = await prisma.$queryRawUnsafe<SignalRow[]>(
    `SELECT id, ts_code AS "tsCode", matched_date AS "matchedDate", strategy, signal_type AS "signalType"
     FROM short_term_signals WHERE matched_date >= $1 ORDER BY matched_date, ts_code`,
    since
  );
  console.log(`[backfill-short-term-eval] 待回填信号 ${signals.length} 条`);
  if (!signals.length) return { signals: 0, computed: 0, pending: 0 };

  // 收集需要的 (tsCode, tradeDate)：信号日 + 次日
  const pairSet = new Set<string>();
  let pending = 0;
  for (const sig of signals) {
    const entryIdx = dayIndex.get(ymd8(sig.matchedDate));
    if (entryIdx == null) { pending++; continue; }
    pairSet.add(`${sig.tsCode}|${sortedDays[entryIdx]}`);
    const nextIdx = entryIdx + 1;
    if (nextIdx < sortedDays.length) pairSet.add(`${sig.tsCode}|${sortedDays[nextIdx]}`);
    else pending++;
  }

  const pairs = [...pairSet].map((s) => s.split("|") as [string, string]);
  const barBy = new Map<string, BarPoint>();
  for (let i = 0; i < pairs.length; i += PAIR_CHUNK) {
    const chunk = pairs.slice(i, i + PAIR_CHUNK);
    const placeholders = chunk.map((_, j) => `($${j * 2 + 1}, $${j * 2 + 2})`).join(",");
    const rows = await prisma.$queryRawUnsafe<{ tsCode: string; tradeDate: string; open: number | null; high: number | null; low: number | null; close: number | null }[]>
      (`SELECT "tsCode" AS "tsCode", "tradeDate" AS "tradeDate", open, high, low, close FROM daily_bars WHERE ("tsCode", "tradeDate") IN (${placeholders})`,
      ...chunk.flat());
    for (const r of rows) {
      if (r.close == null) continue;
      barBy.set(`${r.tsCode}|${r.tradeDate}`, { open: r.open ?? r.close, high: r.high ?? r.close, low: r.low ?? r.close, close: r.close });
    }
  }

  const toWrite: { signalId: string; exitType: string; exitPrice: number; returnPct: number }[] = [];
  for (const sig of signals) {
    const entryIdx = dayIndex.get(ymd8(sig.matchedDate));
    if (entryIdx == null) { pending++; continue; }
    const nextIdx = entryIdx + 1;
    if (nextIdx >= sortedDays.length) { pending++; continue; }
    const entryBar = barBy.get(`${sig.tsCode}|${sortedDays[entryIdx]}`);
    const nextBar = barBy.get(`${sig.tsCode}|${sortedDays[nextIdx]}`);
    if (!entryBar || !nextBar || entryBar.close <= 0) { pending++; continue; }
    const entry = entryBar.close;
    for (const t of EXIT_TYPES) {
      const exit = nextBar[t] ?? entry;
      const returnPct = (exit / entry - 1) * 100;
      toWrite.push({
        signalId: sig.id,
        exitType: t,
        exitPrice: Math.round(exit * 10000) / 10000,
        returnPct: Math.round(returnPct * 10000) / 10000,
      });
    }
  }

  const upsert = `INSERT INTO short_term_evals (signal_id, exit_type, exit_price, return_pct, created_at)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (signal_id, exit_type) DO UPDATE SET
      exit_price = EXCLUDED.exit_price,
      return_pct = EXCLUDED.return_pct,
      created_at = EXCLUDED.created_at`;
  const createdAt = new Date().toISOString();
  for (let i = 0; i < toWrite.length; i += WRITE_BATCH) {
    const chunk = toWrite.slice(i, i + WRITE_BATCH);
    await prisma.$transaction(
      chunk.map((u) => prisma.$executeRawUnsafe(upsert, u.signalId, u.exitType, u.exitPrice, u.returnPct, createdAt))
    );
  }

  return { signals: signals.length, computed: toWrite.length, pending };
}

const STRATEGY_NAMES: Record<string, string> = {
  "limit-up-three-yin": "板三阴",
  "dragon-first-yin": "龙首阴",
  "double-dragon": "双龙",
  "dragon-four-yin": "龙四阴",
  "xian-ren-zhi-lu": "仙人指路",
};

export async function loadShortTermStats() {
  await ensureShortTermEvalTable();
  const rows = await prisma.$queryRawUnsafe<{ strategy: string; exitType: string; returnPct: number }[]>(
    `SELECT s.strategy, e.exit_type AS "exitType", e.return_pct AS "returnPct"
     FROM short_term_evals e
     JOIN short_term_signals s ON s.id = e.signal_id
     WHERE e.return_pct IS NOT NULL AND s.strategy <> 'double-shot'
     ORDER BY s.strategy, e.exit_type`
  );

  const byStrategy = new Map<string, Map<string, number[]>>();
  for (const r of rows) {
    if (!byStrategy.has(r.strategy)) byStrategy.set(r.strategy, new Map());
    const byT = byStrategy.get(r.strategy)!;
    if (!byT.has(r.exitType)) byT.set(r.exitType, []);
    byT.get(r.exitType)!.push(Number(r.returnPct));
  }

  const strategies = [...byStrategy.entries()].map(([sid, byT]) => {
    const high = byT.get("high") ?? [];
    const byExit: Record<string, any> = {};
    for (const t of EXIT_TYPES) byExit[t] = returnStats(byT.get(t) ?? []);
    const primary = returnStats(high);
    return {
      strategyId: sid,
      strategyName: STRATEGY_NAMES[sid] ?? sid,
      evaluatedCount: primary.count,
      avgReturn: primary.avg,
      winRate: primary.winRate,
      byExit,
    };
  }).sort((a, b) => (b.evaluatedCount || 0) - (a.evaluatedCount || 0));

  const allHigh = rows.filter((r) => r.exitType === "high").map((r) => Number(r.returnPct)).filter((r) => Number.isFinite(r));
  const summary = returnStats(allHigh);
  return { primaryExit: "high", summary, strategies };
}

/**
 * 复盘历史明细：按信号日（matched_date）分组，返回每只标的次日（T+1）四档涨幅。
 * 四档：open / high / low / close（相对信号日收盘价）。
 */
export async function loadShortTermHistory() {
  await ensureShortTermEvalTable();
  const rows = await prisma.$queryRawUnsafe<{
    id: string; strategy: string; name: string; tsCode: string;
    matchedDate: string; signalType: string; exitType: string; returnPct: number;
  }[]>(
    `SELECT s.id, s.strategy, s.name, s.ts_code AS "tsCode", s.matched_date AS "matchedDate",
            s.signal_type AS "signalType", e.exit_type AS "exitType", e.return_pct AS "returnPct"
     FROM short_term_evals e
     JOIN short_term_signals s ON s.id = e.signal_id
     WHERE e.return_pct IS NOT NULL AND s.strategy <> 'double-shot'
     ORDER BY s.matched_date DESC, s.strategy, s.ts_code, e.exit_type`
  );

  const bySignal = new Map<string, {
    id: string; strategy: string; strategyName: string; name: string; tsCode: string;
    matchedDate: string; signalType: string; t1: Record<string, number>;
  }>();
  for (const r of rows) {
    if (!bySignal.has(r.id)) {
      bySignal.set(r.id, {
        id: r.id, strategy: r.strategy, strategyName: STRATEGY_NAMES[r.strategy] ?? r.strategy,
        name: r.name, tsCode: r.tsCode, matchedDate: r.matchedDate, signalType: r.signalType, t1: {},
      });
    }
    bySignal.get(r.id)!.t1[r.exitType] = Number(r.returnPct);
  }

  const byDate = new Map<string, any[]>();
  for (const s of bySignal.values()) {
    if (!byDate.has(s.matchedDate)) byDate.set(s.matchedDate, []);
    byDate.get(s.matchedDate)!.push(s);
  }
  const dates = [...byDate.keys()].sort().reverse();
  return { dates, byDate: Object.fromEntries(byDate) };
}
