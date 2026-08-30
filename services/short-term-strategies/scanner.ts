/**
 * 短线策略 — 扫描编排（单阶段）
 *
 *  - closing（T 日尾盘 14:55）：全量扫描五套策略，可选落库快照。
 *
 * 编排层依赖可注入的 ShortTermDataSource，便于纯逻辑单测。
 */

import { ALL_STRATEGY_IDS, LOOKBACK_TRADING_DAYS, PREFILTER_TRADING_DAYS } from "./config";
import { buildAllCandidates } from "./engine";
import { isMainBoardNonST } from "@/lib/strategy/dragon-first-yin";
import { PrefilterCode, PrismaShortTermDataSource, ShortTermDataSource } from "./data-source";
import { buildMarketContext, loadMarketExtras } from "./market";
import { ensureShortTermTables, loadScanLog, loadSnapshot, saveScanLog, saveSnapshot } from "./persist";
import { getQuotesBatch } from "@/lib/server-quote-cache";
import { beijingTodayStr } from "@/lib/stock-helpers";
import type {
  MarketContext,
  SeriesInput,
  ShortBar,
  ShortTermCandidate,
  ShortTermPhase,
  ShortTermScanResult,
  ShortTermStrategyId,
  SnapshotRow,
} from "./types";

export interface ScanOptions {
  strategies?: ShortTermStrategyId[];
  tradeDate?: string; // 覆盖基准交易日（YYYYMMDD）
  persist?: boolean; // 是否落库快照（仅尾盘自动任务为 true）
  dataSource?: ShortTermDataSource;
}

export function emptyStrategies(): Record<ShortTermStrategyId, ShortTermCandidate[]> {
  return { "limit-up-three-yin": [], "dragon-first-yin": [], "double-dragon": [], "dragon-four-yin": [], "xian-ren-zhi-lu": [] };
}

export function groupByStrategy(
  candidates: ShortTermCandidate[]
): Record<ShortTermStrategyId, ShortTermCandidate[]> {
  const out = emptyStrategies() as Record<string, ShortTermCandidate[]>;
  for (const c of candidates) (out[c.strategy] ??= []).push(c);
  return out;
}

function candidateToRow(c: ShortTermCandidate, phase: ShortTermPhase, tradeDate: string): SnapshotRow {
  return {
    strategy: c.strategy,
    phase,
    tradeDate,
    tsCode: c.tsCode,
    name: c.name,
    signalType: c.signalType,
    matchedDate: c.matchedDate,
    priority: c.priority,
    reason: c.reason,
    summary: c.summary,
    metrics: c.metrics,
  };
}

export function rowToCandidate(r: SnapshotRow): ShortTermCandidate {
  return {
    strategy: r.strategy,
    tsCode: r.tsCode,
    name: r.name,
    signalType: r.signalType,
    matchedDate: r.matchedDate,
    priority: r.priority,
    reason: r.reason,
    summary: r.summary,
    metrics: r.metrics,
  };
}

function tsCodeToSymbol(tsCode: string): string {
  const m = tsCode.match(/^(\d+)\.(SH|SZ|BJ)$/i);
  return m ? m[2].toLowerCase() + m[1] : tsCode.toLowerCase();
}

function prevCloseOf(bars: ShortBar[], i: number): number | null {
  const b = bars[i];
  if (b.preClose != null && b.preClose > 0) return b.preClose;
  return i > 0 ? bars[i - 1].close : null;
}

function isLimitUpBar(bars: ShortBar[], i: number): boolean {
  const b = bars[i];
  if (!b) return false;
  const prev = prevCloseOf(bars, i);
  if (!prev || prev <= 0) return false;
  const limitPrice = Math.round(prev * 1.1 * 100) / 100;
  return Math.abs(b.close - limitPrice) <= 0.01 && b.high >= limitPrice - 0.01;
}

/** 用实时行情合成今日 K 线并追加到各候选序列，让扫描真正跑在 T 日。 */
async function appendTodayBars(
  series: SeriesInput[]
): Promise<{ series: SeriesInput[]; today8: string | null; appended: number }> {
  if (series.length === 0) return { series, today8: null, appended: 0 };
  const todayStr = beijingTodayStr();
  const symbols = series.map((s) => tsCodeToSymbol(s.tsCode));
  const quotes = await getQuotesBatch(symbols);
  let appended = 0;
  const out = series.map((s) => {
    const symbol = tsCodeToSymbol(s.tsCode);
    const q = quotes.get(symbol);
    if (!q || !q.updateTime?.startsWith(todayStr)) return s;
    const bar: ShortBar = {
      date: todayStr,
      open: q.open,
      high: q.high,
      low: q.low,
      close: q.price,
      volume: q.volume,
      preClose: q.preClose,
      turnoverRate: q.turnover ?? null,
    };
    appended++;
    // 若 DB 已含今日 bar（收盘后已同步），用实时数据替换最后一根，避免重复追加导致引擎错位
    const lastBar = s.bars[s.bars.length - 1];
    if (lastBar && lastBar.date === todayStr) {
      return { ...s, bars: [...s.bars.slice(0, -1), bar] };
    }
    return { ...s, bars: [...s.bars, bar] };
  });
  return { series: out, today8: appended > 0 ? todayStr.replace(/-/g, "") : null, appended };
}

/** T 日尾盘：全量扫描 + 可选落库 */
export async function runClosingScan(opts: ScanOptions = {}): Promise<ShortTermScanResult> {
  const strategies = opts.strategies?.length ? opts.strategies : ALL_STRATEGY_IDS;
  const ds = opts.dataSource ?? new PrismaShortTermDataSource();
  const latest = opts.tradeDate ?? (await ds.getLatestTradeDate());
  if (!latest) throw new Error("无可用日线数据");

  const datesDesc = await ds.getTradeDates(LOOKBACK_TRADING_DAYS + 1);
  const lookbackStart = datesDesc.length ? datesDesc[datesDesc.length - 1] : latest;

  const [breadth, extras] = await Promise.all([
    ds.loadMarketBreadth(latest),
    loadMarketExtras(latest),
  ]);
  const market = await buildMarketContext(
    breadth?.limitUp ?? 0,
    breadth?.limitDown ?? 0,
    extras.brokenCount,
    extras.highestBoard
  );

  let candidates: ShortTermCandidate[] = [];
  let scanDate = latest;
  let today8: string | null = null;
  {
    // SQL 前置：每套策略先筛出可能命中的 code，再只拉这些 code 的完整回看窗口 K 线
    const prefilterStart =
      datesDesc[Math.min(PREFILTER_TRADING_DAYS, Math.max(0, datesDesc.length - 1))] ?? lookbackStart;
    const codeSets = await Promise.all(
      strategies.map((s) => ds.prefilterCodes(s, prefilterStart, latest))
    );
    const codeMap = new Map<string, PrefilterCode>();
    for (const set of codeSets) {
      for (const c of set) if (!codeMap.has(c.tsCode)) codeMap.set(c.tsCode, c);
    }

    // 补「今日实时涨停池」：信号日=今天时，DB 尚无今天的日线，SQL 前置会漏掉
    // 首板昨日 + 今日二板（双龙）等场景；这里把今天涨停标的并入候选。
    try {
      const { getLimitUpPool, normalizeThscode } = await import("@/lib/fuyao");
      const pool = await getLimitUpPool();
      for (const it of pool?.item ?? []) {
        const code = normalizeThscode(String(it.thscode ?? ""));
        if (!code || codeMap.has(code)) continue;
        if (!isMainBoardNonST(code, it.name)) continue;
        codeMap.set(code, { tsCode: code, name: it.name ?? "" });
      }
    } catch {
      /* 忽略：实时涨停池不可用时仅靠 DB 前置 */
    }

    // 补「昨日涨停池」：覆盖昨日连板、今日首阴（龙首阴）等今天信号。
    try {
      const { getLimitListD } = await import("@/lib/tushare");
      const yday = datesDesc[1] ?? latest;
      const rows = await getLimitListD(yday, "U");
      for (const row of rows) {
        const code = String(row.ts_code ?? "");
        if (!code || codeMap.has(code)) continue;
        if (!isMainBoardNonST(code, row.name)) continue;
        codeMap.set(code, { tsCode: code, name: row.name ? String(row.name) : "" });
      }
    } catch {
      /* 忽略：昨日涨停池不可用时仅靠 DB 前置 */
    }

    const codes = Array.from(codeMap.values());

    let series = await ds.loadSeriesForCodes(codes, lookbackStart, latest);
    const today = await appendTodayBars(series);
    series = today.series;
    if (today.today8) { scanDate = today.today8; today8 = today.today8; }
    candidates = buildAllCandidates(series, strategies);
  }

  if (opts.persist) {
    await ensureShortTermTables();
    await saveSnapshot({
      rows: candidates.map((c) => candidateToRow(c, "closing", scanDate)),
      tradeDate: scanDate,
      phase: "closing",
      clearStrategies: strategies,
    });
    await saveScanLog(scanDate, "closing", candidates.length);
  }

  return {
    phase: "closing",
    tradeDate: scanDate,
    generatedAt: new Date().toISOString(),
    market,
    strategies: groupByStrategy(candidates),
  };
}

export interface SnapshotResult {
  strategies: Record<ShortTermStrategyId, ShortTermCandidate[]>;
  tradeDate: string;
  phase: ShortTermPhase;
  generatedAt: string | null;
  generated: boolean;
  market: MarketContext | null;
}

/** 读取落库快照（UI 展示用；generated 看扫描日志，0 命中当天也能正确区分） */
export async function loadSnapshotResult(opts: {
  strategy?: ShortTermStrategyId;
  tradeDate?: string;
} = {}): Promise<SnapshotResult> {
  const ds = new PrismaShortTermDataSource();
  const latest = (await ds.getLatestTradeDate()) ?? "";
  await ensureShortTermTables();
  const rows = await loadSnapshot({
    strategy: opts.strategy,
    phase: "closing",
    tradeDate: opts.tradeDate,
  });
  const logRows = await loadScanLog();

  const snapDates = Array.from(new Set(rows.map((r) => r.tradeDate)));
  const logDates = logRows.map((l) => l.tradeDate);
  const allDates = Array.from(new Set([...snapDates, ...logDates])).sort().reverse();
  const snapDate = opts.tradeDate ?? allDates[0] ?? "";
  const snapRows = snapDate ? rows.filter((r) => r.tradeDate === snapDate) : [];
  const candidates = snapRows.map(rowToCandidate);

  let market: MarketContext | null = null;
  if (snapDate) {
    const breadth = await ds.loadMarketBreadth(snapDate);
    market = await buildMarketContext(
      breadth?.limitUp ?? 0,
      breadth?.limitDown ?? 0,
      null,
      null
    );
  }

  const logRow = logRows.find((l) => l.tradeDate === snapDate);
  const generated = snapRows.length > 0 || !!logRow;
  const generatedAt = logRow?.createdAt ?? (snapRows.length ? snapRows[0].createdAt ?? null : null);

  return {
    strategies: groupByStrategy(candidates),
    tradeDate: snapDate || latest,
    phase: "closing",
    generatedAt,
    generated,
    market,
  };
}
