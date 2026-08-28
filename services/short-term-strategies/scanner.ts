/**
 * 短线策略 — 扫描编排（两阶段）
 *
 *  - closing（T 日尾盘 14:30）：全量扫描三套策略，可选落库快照。
 *  - morning（T+1 早盘）：复用 closing 快照，只做实时过滤（不重扫全市场）。
 *
 * 编排层依赖可注入的 ShortTermDataSource，便于纯逻辑单测。
 */

import { ALL_STRATEGY_IDS, LOOKBACK_TRADING_DAYS } from "./config";
import { buildAllCandidates } from "./engine";
import { PrismaShortTermDataSource, ShortTermDataSource } from "./data-source";
import { buildMarketContext, loadMarketExtras } from "./market";
import { ensureShortTermTables, loadSnapshot, saveSnapshot } from "./persist";
import { applyRealtimeFilters, loadRealtimeContext } from "./realtime";
import { getQuotesBatch } from "@/lib/server-quote-cache";
import { beijingTodayStr } from "@/lib/stock-helpers";
import { analyzeDragonRun } from "@/lib/strategy/dragon-first-yin";
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
  phase?: ShortTermPhase;
  strategies?: ShortTermStrategyId[];
  tradeDate?: string; // 覆盖基准交易日（YYYYMMDD）
  snapshotDate?: string; // morning 阶段指定要刷新的快照交易日（YYYYMMDD）
  persist?: boolean; // closing 阶段是否落库快照
  dataSource?: ShortTermDataSource;
}

export function emptyStrategies(): Record<ShortTermStrategyId, ShortTermCandidate[]> {
  return { "limit-up-three-yin": [], "dragon-first-yin": [], "double-dragon": [] };
}

export function groupByStrategy(
  candidates: ShortTermCandidate[]
): Record<ShortTermStrategyId, ShortTermCandidate[]> {
  const out = emptyStrategies();
  for (const c of candidates) out[c.strategy].push(c);
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

/** 拉实时行情前先按历史 bar 做策略前置过滤，避免给全市场候选都合成今日 K 线。 */
function prefilterForToday(series: SeriesInput[], strategies: ShortTermStrategyId[]): SeriesInput[] {
  return series.filter((s) => {
    const bars = s.bars;
    const n = bars.length;
    if (n < 3) return false;

    if (strategies.includes("double-dragon")) {
      // 今日二板：昨日须为首板；今日回踩：二板须在近 1~3 日内
      if (isLimitUpBar(bars, n - 1) && !isLimitUpBar(bars, n - 2)) return true;
      for (const b2 of [n - 2, n - 3]) {
        if (b2 >= 1 && isLimitUpBar(bars, b2) && !isLimitUpBar(bars, b2 - 1)) return true;
      }
    }

    if (strategies.includes("dragon-first-yin")) {
      const run = analyzeDragonRun(bars as any, n - 2);
      if (run && run.boardCount >= 3) return true;
    }

    if (strategies.includes("limit-up-three-yin")) {
      if (n >= 4 && isLimitUpBar(bars, n - 4)) {
        const y1 = bars[n - 3];
        const y2 = bars[n - 2];
        if (y1 && y2 && y1.close < y1.open && y2.close < y2.open) return true;
      }
    }

    return false;
  });
}

/** 用实时行情合成今日 K 线并追加到各候选序列，让 14:30 扫描真正跑在 T 日。 */
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
  if (market.tradable) {
    let series = await ds.loadCandidateSeries(lookbackStart, latest);
    // 先用历史 bar 做策略前置过滤，再对可能命中的标的合成今日 K 线
    series = prefilterForToday(series, strategies);
    const today = await appendTodayBars(series);
    series = today.series;
    if (today.today8) scanDate = today.today8;
    candidates = buildAllCandidates(series, strategies);
  }

  // 双龙战法实时把关：连板高度==2 + 二板早于首板封板
  if (candidates.some((c) => c.strategy === "double-dragon")) {
    const yesterdayTradeDate = datesDesc[1] ?? latest;
    const ctx = await loadRealtimeContext(yesterdayTradeDate);
    candidates = applyRealtimeFilters(candidates, ctx);
  }

  if (opts.persist) {
    await ensureShortTermTables();
    await saveSnapshot(candidates.map((c) => candidateToRow(c, "closing", scanDate)));
  }

  return {
    phase: "closing",
    tradeDate: scanDate,
    generatedAt: new Date().toISOString(),
    market,
    strategies: groupByStrategy(candidates),
  };
}

/** T+1 早盘：复用 closing 快照 + 实时过滤，不重扫 */
export async function runMorningRefresh(opts: ScanOptions = {}): Promise<ShortTermScanResult> {
  const strategies = opts.strategies?.length ? opts.strategies : ALL_STRATEGY_IDS;
  const ds = opts.dataSource ?? new PrismaShortTermDataSource();
  const latest = opts.tradeDate ?? (await ds.getLatestTradeDate());
  if (!latest) throw new Error("无可用日线数据");

  await ensureShortTermTables();
  const rows = await loadSnapshot({ phase: "closing" });
  const dates = Array.from(new Set(rows.map((r) => r.tradeDate))).sort().reverse();
  const snapDate = opts.snapshotDate ?? dates[0];
  const snapRows = snapDate ? rows.filter((r) => r.tradeDate === snapDate) : [];
  const candidates = snapRows
    .map(rowToCandidate)
    .filter((c) => strategies.includes(c.strategy));

  const datesDesc = await ds.getTradeDates(2);
  const yesterdayTradeDate = datesDesc[1] ?? snapDate ?? latest;
  const ctx = await loadRealtimeContext(yesterdayTradeDate);
  const filtered = applyRealtimeFilters(candidates, ctx);

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

  return {
    phase: "morning",
    tradeDate: snapDate ?? latest,
    generatedAt: new Date().toISOString(),
    market,
    strategies: groupByStrategy(filtered),
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

/** 读取落库快照（UI 展示用；空态区分「未到运行时间/尚未生成」= generated:false） */
export async function loadSnapshotResult(opts: {
  strategy?: ShortTermStrategyId;
  phase?: ShortTermPhase;
  tradeDate?: string;
} = {}): Promise<SnapshotResult> {
  const ds = new PrismaShortTermDataSource();
  const latest = (await ds.getLatestTradeDate()) ?? "";
  await ensureShortTermTables();
  const rows = await loadSnapshot({
    strategy: opts.strategy,
    phase: opts.phase,
    tradeDate: opts.tradeDate,
  });
  const dates = Array.from(new Set(rows.map((r) => r.tradeDate))).sort().reverse();
  const snapDate = opts.tradeDate ?? dates[0] ?? "";
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

  return {
    strategies: groupByStrategy(candidates),
    tradeDate: snapDate || latest,
    phase: opts.phase ?? "closing",
    generatedAt: snapRows.length ? snapRows[0].createdAt ?? null : null,
    generated: snapRows.length > 0,
    market,
  };
}
