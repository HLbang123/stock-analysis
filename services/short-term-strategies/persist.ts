/**
 * 短线策略 — 候选快照落库（raw SQL 表 short_term_signals）
 *
 * 不跑 prisma db push：本表非 Prisma 模型，建表走 raw SQL（CREATE TABLE IF NOT EXISTS），
 * 与 review_calendar_days / index_daily 同一模式。列名全部 snake_case。
 */

import { randomUUID } from "crypto";
import { prisma } from "@/lib/db";
import type { ShortTermPhase, ShortTermStrategyId, SnapshotRow } from "./types";

export const SHORT_TERM_SIGNALS_DDL: string[] = [
  "CREATE TABLE IF NOT EXISTS short_term_signals (" +
    "id VARCHAR(36) PRIMARY KEY," +
    "strategy VARCHAR(32) NOT NULL," +
    "phase VARCHAR(16) NOT NULL," +
    "trade_date VARCHAR(8) NOT NULL," +
    "ts_code VARCHAR(12) NOT NULL," +
    "name VARCHAR(40)," +
    "signal_type VARCHAR(24) NOT NULL," +
    "matched_date VARCHAR(10) NOT NULL," +
    "priority VARCHAR(8) NOT NULL," +
    "reason VARCHAR(200)," +
    "summary VARCHAR(300)," +
    "metrics JSONB," +
    "created_at VARCHAR(32) NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_short_term_signals_lookup ON short_term_signals (strategy, phase, trade_date)",
  "CREATE UNIQUE INDEX IF NOT EXISTS uq_short_term_signals ON short_term_signals (strategy, phase, trade_date, ts_code, signal_type)",
];

export const SHORT_TERM_SCAN_LOG_DDL: string[] = [
  "CREATE TABLE IF NOT EXISTS short_term_scan_log (" +
    "trade_date VARCHAR(8) PRIMARY KEY," +
    "phase VARCHAR(16) NOT NULL," +
    "candidate_count INTEGER NOT NULL," +
    "created_at VARCHAR(32) NOT NULL)",
];

export async function ensureShortTermTables(): Promise<void> {
  for (const sql of [...SHORT_TERM_SIGNALS_DDL, ...SHORT_TERM_SCAN_LOG_DDL]) {
    await prisma.$executeRawUnsafe(sql);
  }
}

const UPSERT_SQL = [
  "INSERT INTO short_term_signals",
  "(id, strategy, phase, trade_date, ts_code, name, signal_type, matched_date, priority, reason, summary, metrics, created_at)",
  "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)",
  "ON CONFLICT (strategy, phase, trade_date, ts_code, signal_type)",
  "DO UPDATE SET name = EXCLUDED.name, matched_date = EXCLUDED.matched_date, priority = EXCLUDED.priority,",
  "reason = EXCLUDED.reason, summary = EXCLUDED.summary, metrics = EXCLUDED.metrics, created_at = EXCLUDED.created_at",
].join(" ");

export interface SaveSnapshotInput {
  rows: SnapshotRow[];
  tradeDate: string;
  phase: ShortTermPhase;
  /** 本次扫描覆盖的策略范围；即使 0 命中也要清空这些策略当天的旧行 */
  clearStrategies: ShortTermStrategyId[];
}

export async function saveSnapshot(input: SaveSnapshotInput): Promise<number> {
  const { rows, tradeDate, phase, clearStrategies } = input;
  const strategies = clearStrategies.length
    ? clearStrategies
    : Array.from(new Set(rows.map((r) => r.strategy)));
  await prisma.$executeRawUnsafe(
    "DELETE FROM short_term_signals WHERE phase = $1 AND trade_date = $2 AND strategy = ANY($3)",
    phase,
    tradeDate,
    strategies
  );
  const createdAt = new Date().toISOString();
  for (const r of rows) {
    await prisma.$executeRawUnsafe(
      UPSERT_SQL,
      randomUUID(),
      r.strategy,
      r.phase,
      r.tradeDate,
      r.tsCode,
      r.name || null,
      r.signalType,
      r.matchedDate,
      r.priority,
      r.reason || null,
      r.summary || null,
      JSON.stringify(r.metrics ?? {}),
      createdAt
    );
  }
  return rows.length;
}

export interface ScanLogRow {
  tradeDate: string;
  phase: string;
  candidateCount: number;
  createdAt: string;
}

const UPSERT_SCAN_LOG_SQL = [
  "INSERT INTO short_term_scan_log (trade_date, phase, candidate_count, created_at)",
  "VALUES ($1, $2, $3, $4)",
  "ON CONFLICT (trade_date) DO UPDATE SET phase = EXCLUDED.phase, candidate_count = EXCLUDED.candidate_count, created_at = EXCLUDED.created_at",
].join(" ");

export async function saveScanLog(tradeDate: string, phase: ShortTermPhase, candidateCount: number): Promise<void> {
  await prisma.$executeRawUnsafe(
    UPSERT_SCAN_LOG_SQL,
    tradeDate,
    phase,
    candidateCount,
    new Date().toISOString()
  );
}

export async function loadScanLog(): Promise<ScanLogRow[]> {
  const rows: any[] = await prisma.$queryRawUnsafe(
    "SELECT trade_date, phase, candidate_count, created_at FROM short_term_scan_log ORDER BY trade_date DESC"
  );
  return rows.map((r) => ({
    tradeDate: String(r.trade_date),
    phase: String(r.phase),
    candidateCount: Number(r.candidate_count),
    createdAt: String(r.created_at),
  }));
}

const SELECT_SQL = [
  "SELECT strategy, phase, trade_date, ts_code, name, signal_type, matched_date, priority, reason, summary, metrics, created_at",
  "FROM short_term_signals",
  "WHERE ($1::text IS NULL OR strategy = $1)",
  "AND ($2::text IS NULL OR phase = $2)",
  "AND ($3::text IS NULL OR trade_date = $3)",
  "AND strategy <> 'double-shot'",
  "ORDER BY strategy, trade_date DESC, ts_code, signal_type",
].join(" ");

export async function loadSnapshot(opts: {
  strategy?: ShortTermStrategyId;
  phase?: ShortTermPhase;
  tradeDate?: string;
}): Promise<SnapshotRow[]> {
  const rows: any[] = await prisma.$queryRawUnsafe(
    SELECT_SQL,
    opts.strategy ?? null,
    opts.phase ?? null,
    opts.tradeDate ?? null
  );
  return rows.map((r) => ({
    strategy: String(r.strategy) as ShortTermStrategyId,
    phase: String(r.phase) as ShortTermPhase,
    tradeDate: String(r.trade_date),
    tsCode: String(r.ts_code),
    name: r.name ?? "",
    signalType: String(r.signal_type),
    matchedDate: String(r.matched_date),
    priority: String(r.priority) as SnapshotRow["priority"],
    reason: r.reason ?? "",
    summary: r.summary ?? null,
    metrics: (r.metrics ?? {}) as Record<string, unknown>,
    createdAt: r.created_at ? String(r.created_at) : "",
  }));
}
