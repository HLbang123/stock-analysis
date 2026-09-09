/**
 * 短线策略 — 扫描编排（单阶段）
 *
 *  - closing（T 日尾盘 14:55）：全量扫描六套策略，可选落库快照。
 *
 * 编排层依赖可注入的 ShortTermDataSource，便于纯逻辑单测。
 */

import { ALL_STRATEGY_IDS, LOOKBACK_TRADING_DAYS } from "./config";
import { buildAllCandidates } from "./engine";
import { fmtDate, PrismaShortTermDataSource, ShortTermDataSource } from "./data-source";
import { buildMarketContext, loadMarketExtras } from "./market";
import { ensureShortTermTables, loadScanLog, loadSnapshot, saveScanLog, saveSnapshot } from "./persist";
import { scoreCandidate } from "./score";
import { getQuotesBatch } from "@/lib/server-quote-cache";
import { computeSectorXianRenStatsByStock } from "@/lib/concepts";
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
  return { "limit-up-three-yin": [], "dragon-first-yin": [], "double-dragon": [], "dragon-four-yin": [], "xian-ren-zhi-lu": [], "limit-up-board": [] };
}

export function groupByStrategy(
  candidates: ShortTermCandidate[]
): Record<ShortTermStrategyId, ShortTermCandidate[]> {
  const out = emptyStrategies() as Record<string, ShortTermCandidate[]>;
  for (const c of candidates) (out[c.strategy] ??= []).push(c);
  // 组内按强弱分（score 0-100）降序，同分再按 priority（强→中→弱）
  const rank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  for (const key of Object.keys(out)) {
    out[key].sort((a, b) => (b.score - a.score) || (rank[a.priority] - rank[b.priority]));
  }
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
    metrics: { ...c.metrics, score: c.score },
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
    score: typeof r.metrics?.score === "number" ? r.metrics.score : r.priority === "high" ? 80 : r.priority === "medium" ? 55 : 30,
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

/** 统计序列里含「今日 bar」的标的数（用于本地统计的覆盖率把关） */
function countTodayBars(series: SeriesInput[], today8: string): number {
  const today = fmtDate(today8);
  let n = 0;
  for (const s of series) if (s.bars[s.bars.length - 1]?.date === today) n += 1;
  return n;
}

interface LocalMarketStats {
  limitUp: number;
  limitDown: number;
  broken: number;
  highestBoard: number;
}

/**
 * 用「已载入的日线序列（含今日实时合成 bar）」本地推算今日市场统计。
 * 2026-09-10 新增：作为 fuyao/tushare 外部数据的**降级兜底**——外部源挂了不再静默，
 * 而是用本地口径给出可用值（口径：涨停=收盘封在涨停价且最高触及；炸板=触及涨停未封）。
 * @param today8 今日 YYYYMMDD；为空（周末/节假日/无行情）时不做推算
 */
function computeLocalMarketStats(series: SeriesInput[], today8: string | null): LocalMarketStats {
  const out: LocalMarketStats = { limitUp: 0, limitDown: 0, broken: 0, highestBoard: 0 };
  if (!today8) return out;
  const today = fmtDate(today8);
  for (const s of series) {
    const bars = s.bars;
    const i = bars.length - 1;
    const b = bars[i];
    if (!b || b.date !== today) continue;
    const limitPct = /^(300|301|688|689)/.test(s.tsCode) ? 0.2 : 0.1;
    const prev = b.preClose != null && b.preClose > 0 ? b.preClose : bars[i - 1]?.close ?? null;
    if (prev == null || prev <= 0) continue;
    const up = Math.round(prev * (1 + limitPct) * 100) / 100;
    const down = Math.round(prev * (1 - limitPct) * 100) / 100;
    const sealedUp = Math.abs(b.close - up) <= 0.011 && b.high >= up - 0.011;
    if (sealedUp) out.limitUp += 1;
    else if (b.high >= up - 0.011) out.broken += 1; // 触板未封 = 炸板
    if (Math.abs(b.close - down) <= 0.011 && b.low <= down + 0.011) out.limitDown += 1;
    if (!sealedUp) continue;
    // 连板高度：自今日往前数连续涨停
    let n = 0;
    for (let k = i; k >= 1; k--) {
      const cur = bars[k];
      const pv = cur.preClose != null && cur.preClose > 0 ? cur.preClose : bars[k - 1]?.close ?? null;
      if (pv == null || pv <= 0) break;
      const lim = Math.round(pv * (1 + limitPct) * 100) / 100;
      if (Math.abs(cur.close - lim) <= 0.011 && cur.high >= lim - 0.011) n += 1;
      else break;
    }
    if (n > out.highestBoard) out.highestBoard = n;
  }
  return out;
}

/**
 * 用实时行情合成今日 K 线并追加到各候选序列，让扫描真正跑在 T 日。
 * 拿不到今日行情的标的会记进 staleCodes：调用方在「今日模式」下把它们剔除，
 * 避免用昨天那根 K 线做形态判定、却当成今天的信号报出去（静默误报）。
 */
async function appendTodayBars(
  series: SeriesInput[]
): Promise<{ series: SeriesInput[]; today8: string | null; appended: number; staleCodes: string[] }> {
  if (series.length === 0) return { series, today8: null, appended: 0, staleCodes: [] };
  const todayStr = beijingTodayStr();
  const symbols = series.map((s) => tsCodeToSymbol(s.tsCode));
  const quotes = await getQuotesBatch(symbols);
  let appended = 0;
  const staleCodes: string[] = [];
  const out = series.map((s) => {
    const symbol = tsCodeToSymbol(s.tsCode);
    const q = quotes.get(symbol);
    const lastBar = s.bars[s.bars.length - 1];
    const alreadyToday = lastBar?.date === todayStr; // DB 已同步今日 K 线（收盘后）
    if (!q || !q.updateTime?.startsWith(todayStr)) {
      if (!alreadyToday) staleCodes.push(s.tsCode);
      return s;
    }
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
    if (alreadyToday) {
      return { ...s, bars: [...s.bars.slice(0, -1), bar] };
    }
    return { ...s, bars: [...s.bars, bar] };
  });
  return { series: out, today8: appended > 0 ? todayStr.replace(/-/g, "") : null, appended, staleCodes };
}

/** 单飞（single-flight）：同参数的扫描若已在跑，后来的调用直接复用同一个 Promise。
 *  多人/多标签页同时点「扫描」只会在 2 核服务器上算一次，避免并发把机器打满。 */
const inflightScans = new Map<string, Promise<ShortTermScanResult>>();

/** T 日尾盘：全量扫描 + 可选落库 */
export async function runClosingScan(opts: ScanOptions = {}): Promise<ShortTermScanResult> {
  const key = `${(opts.strategies ?? []).join(",")}|${opts.persist ? 1 : 0}|${opts.tradeDate ?? ""}`;
  const running = inflightScans.get(key);
  if (running) return running;
  const p = runClosingScanInner(opts).finally(() => { inflightScans.delete(key); });
  inflightScans.set(key, p);
  return p;
}

async function runClosingScanInner(opts: ScanOptions = {}): Promise<ShortTermScanResult> {
  const strategies = opts.strategies?.length ? opts.strategies : ALL_STRATEGY_IDS;
  const ds = opts.dataSource ?? new PrismaShortTermDataSource();
  const latest = opts.tradeDate ?? (await ds.getLatestTradeDate());
  if (!latest) throw new Error("无可用日线数据");

  const datesDesc = await ds.getTradeDates(LOOKBACK_TRADING_DAYS + 1);
  const lookbackStart = datesDesc.length ? datesDesc[datesDesc.length - 1] : latest;

  // 外部环境数据与库内广度并行取（best-effort，失败记 warning 不阻断）
  const breadth = await ds.loadMarketBreadth(latest);
  const dataWarnings: string[] = [];
  let market!: MarketContext; // 在 series 载入后填充（需要本地兜底统计）

  let candidates: ShortTermCandidate[] = [];
  let scanDate = latest;
  let today8: string | null = null;
  {
    // 候选池 = 全部在市非 ST（含双创），**无 SQL 预筛**。
    // 2026-09-10 取消预筛：它是引擎规则的手写副本，会与引擎漂移并静默漏报
    // （实测漏掉 68% 的仙人指路信号，见 docs/xianren-empty-day-postmortem.md）。
    // 取消后全市场已包含昨日/今日涨停标的，故原先「今日涨停池(fuyao)」「昨日涨停池(tushare)」
    // 两个候选补充一并移除——扫描关键路径少两个最坏 12s 的外部超时。
    const codes = await ds.loadUniverseCodes();
    if (codes.length === 0) throw new Error("无在市标的");

    let series = await ds.loadSeriesForCodes(codes, lookbackStart, latest);
    const today = await appendTodayBars(series);
    series = today.series;
    if (today.today8) {
      scanDate = today.today8;
      today8 = today.today8;
      // 今日模式下剔除拿不到今日行情的标的：否则它们会用昨天那根 K 线判定形态、
      // 却被当成今天的信号报出去（静默误报）。周末/节假日拿不到行情时今日模式不成立，不走这里。
      if (today.staleCodes.length > 0) {
        const stale = new Set(today.staleCodes);
        series = series.filter((s) => !stale.has(s.tsCode));
        console.warn(`[short-term] ${today.staleCodes.length} 只无今日行情，已跳过（避免用昨日 K 线误报）`);
      }
    } else if (today.staleCodes.length > 0) {
      // 全部标的都没拿到今日行情：正常是周末/节假日（回看上一交易日），但若在交易时段则是上游异常
      console.warn(`[short-term] 无任何今日行情（${today.staleCodes.length} 只），按库内最新交易日扫描`);
    }
    // ---- 市场环境：今日模式一律用「本地当日口径」，非今日模式才回落到库内 EOD + 外部 best-effort ----
    // 2026-09-10：实测本地「最高连板」与 fuyao 连板天梯**完全一致**（同为 4），
    // 而「炸板数」本地 30 vs tushare 0（当日 limit_list_d 尚未生成）——外部源在收盘后一段窗口内
    // 会「成功但返回空」，比失败更隐蔽。故今日模式不再依赖任何第三方，只用心跳得着的本地数据：
    // ① 口径更及时（库内 market_breadth 是昨天 EOD）；② 扫描关键路径彻底摆脱 12s 级外部超时。
    const local = computeLocalMarketStats(series, today8);
    const withToday = today8 ? countTodayBars(series, today8) : 0;
    const coverage = series.length > 0 ? withToday / series.length : 0;
    const useLocal = !!today8 && coverage >= 0.7;
    let limitUp: number;
    let limitDown: number;
    let brokenCount: number | null;
    let highestBoard: number | null;
    if (useLocal) {
      limitUp = local.limitUp;
      limitDown = local.limitDown;
      brokenCount = local.broken;
      highestBoard = local.highestBoard > 0 ? local.highestBoard : null;
      if (coverage < 0.98) {
        dataWarnings.push(`今日行情覆盖 ${(coverage * 100).toFixed(1)}%，市场统计按本地口径估算`);
      }
    } else {
      const extras = await loadMarketExtras(latest);
      dataWarnings.push(...extras.warnings);
      limitUp = breadth?.limitUp ?? 0;
      limitDown = breadth?.limitDown ?? 0;
      brokenCount = extras.brokenCount;
      highestBoard = extras.highestBoard;
      if (today8) {
        dataWarnings.push(`今日行情覆盖仅 ${(coverage * 100).toFixed(1)}%，市场统计回落到库内 EOD + 外部源`);
      }
    }
    if (today8 && today.staleCodes.length > 0) {
      dataWarnings.push(`${today.staleCodes.length} 只标的无今日行情，已跳过（避免用昨日 K 线误报）`);
    }
    market = buildMarketContext(limitUp, limitDown, brokenCount, highestBoard);

    candidates = buildAllCandidates(series, strategies);

    // 补强弱分：板块仙人指路详情（命中板块数/最强上影/最强板块T日量比）+ 确认日换手率
    // （确认日量比已在 detectXianRenAt 做成硬门槛并输出到 metrics，无需此处再算）
    const seriesByCode = new Map(series.map((s) => [s.tsCode, s]));
    // 板块仙人指路详情（命中板块数/最强上影/最强板块T日量比），供三因子打分
    let sectorXianRenStats = new Map<string, { hitCount: number; maxShadow: number; volRatioT: number | null }>();
    let sectorLatest: string | null = null;
    try {
      const r = await computeSectorXianRenStatsByStock(latest);
      sectorXianRenStats = r.stats;
      sectorLatest = r.latestTradeDate;
    } catch { /* 忽略：板块日线不可用时不影响打分 */ }

    // 板块数据新鲜度把关：板块指数是 EOD 数据，盘中天然落后 1 个交易日（可接受）；
    // 落后 ≥2 个交易日说明同步掉了（历史事故：sync-ths-daily 从未进过日任务，落后 2 日），
    // 这时若照旧打分，等于用几天前的板块形态给今天的信号打分，且与回测口径不一致 → 本次置空板块因子。
    const sectorIdx = sectorLatest ? datesDesc.indexOf(sectorLatest) : -1;
    const sectorUsable = sectorIdx >= 0 && sectorIdx <= 1;
    if (!sectorUsable) {
      console.warn(
        `[short-term] 板块日线最新 ${sectorLatest ?? "无数据"}，落后于库内最新交易日 ${latest} 超过 1 日 → 本次跳过板块共振因子`
      );
    }
    for (const c of candidates) {
      if (c.strategy === "xian-ren-zhi-lu") {
        const sr = seriesByCode.get(c.tsCode);
        if (sr) {
          const lastBar = sr.bars[sr.bars.length - 1];
          if (lastBar?.turnoverRate != null) c.metrics["confTurnover"] = lastBar.turnoverRate;
        }
        const st = sectorUsable ? sectorXianRenStats.get(c.tsCode) : undefined;
        if (st) {
          c.metrics["hitCount"] = st.hitCount;
          c.metrics["maxShadow"] = st.maxShadow;
          if (st.volRatioT != null) c.metrics["sectorVolRatioT"] = st.volRatioT;
        }
      }
      c.score = scoreCandidate(c);
    }
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
    dataWarnings,
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
