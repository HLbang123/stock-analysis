/**
 * 短线策略 — 数据源（Prisma + raw SQL，遵守十年数据军规：日期边界 + 候选集）
 *
 * 关键点：
 *  - daily_bars 列名陷阱："tsCode" / "tradeDate" 是 camelCase（raw SQL 带双引号），
 *    pre_close / turnover_rate 是 snake_case（裸用）。
 *  - 取数：loadUniverseCodes（全部在市非 ST，含双创）→ loadSeriesForCodes（回看窗口 K 线）。
 *    **不再有 SQL 预筛**：预筛曾是引擎规则的手写副本，会与引擎漂移并静默漏报，
 *    2026-09-10 删除（见 loadUniverseCodes 注释与 docs/xianren-empty-day-postmortem.md）。
 *  - 日期双边界：start <= tradeDate <= end。
 */

import { prisma } from "@/lib/db";
import { isMainBoardNonST } from "@/lib/strategy/dragon-first-yin";
import type { SeriesInput, ShortBar } from "./types";

export interface MarketBreadthRow {
  tradeDate: string;
  limitUp: number | null;
  limitDown: number | null;
}

export interface PrefilterCode {
  tsCode: string;
  name: string;
}

export interface ShortTermDataSource {
  getLatestTradeDate(): Promise<string | null>;
  getTradeDates(count: number): Promise<string[]>; // 降序 YYYYMMDD
  loadMarketBreadth(tradeDate: string): Promise<MarketBreadthRow | null>;
  loadUniverseCodes(): Promise<PrefilterCode[]>;   // 全部在市非ST标的（含双创）——候选池
  loadSeriesForCodes(codes: PrefilterCode[], lookbackStart: string, endDate: string): Promise<SeriesInput[]>;
}

/** YYYYMMDD → YYYY-MM-DD */
export function fmtDate(d: string): string {
  return d && d.length === 8 ? d.slice(0, 4) + "-" + d.slice(4, 6) + "-" + d.slice(6, 8) : d;
}


/**
 * 全市场 K 线缓存（2026-09-10 加）。
 *
 * 为什么需要：取消 SQL 预筛后每次扫描要物化全市场 K 线——实测 5015 只 × 71 日
 * = 354,771 根，**取数耗时 4.0s**，其中数据库只占 0.32s（EXPLAIN ANALYZE），
 * 其余 ~3.7s 是 Prisma「行 → JS 对象」的物化开销。这笔开销在同一交易日内完全重复。
 *
 * 缓存范围（刻意很小，不是全历史）：**只有扫描窗口那 71 个交易日**、只保留最近 1 份。
 * 体量实测 90.8MB heap（每根 bar 268 字节）。key 带交易日 → 跨日（日线入库后）自动失效。
 *
 * 安全性：调用方 appendTodayBars 是 map 出新对象、不改原数组，所以缓存不会被实时 bar 污染。
 */
const seriesCache = new Map<string, SeriesInput[]>();

/** 便于日志/诊断：当前缓存占用（份数与 bar 总数） */
export function seriesCacheStats(): { entries: number; bars: number } {
  let bars = 0;
  for (const arr of seriesCache.values()) for (const s of arr) bars += s.bars.length;
  return { entries: seriesCache.size, bars };
}

export class PrismaShortTermDataSource implements ShortTermDataSource {
  async getLatestTradeDate(): Promise<string | null> {
    const rows: any[] = await prisma.$queryRawUnsafe(
      'SELECT "tradeDate" FROM daily_bars ORDER BY "tradeDate" DESC LIMIT 1'
    );
    return rows.length ? String(rows[0].tradeDate) : null;
  }

  async getTradeDates(count: number): Promise<string[]> {
    const limit = Math.max(1, Math.floor(count));
    // 交易日历优先走 review_calendar_days（一行/交易日，~2515 行）：
    // 原实现 DISTINCT "tradeDate" FROM daily_bars 实测要扫 ~224 万行索引项 + 55 万次回表（773ms）。
    try {
      const rows: any[] = await prisma.$queryRawUnsafe(
        "SELECT trade_date AS d FROM review_calendar_days ORDER BY trade_date DESC LIMIT $1",
        limit
      );
      if (rows.length >= limit) {
        // 兜底：该表由日更 cron 维护（该步 fatal:false，可能落后于日线）；最大日期必须与库内最新交易日一致
        const mx: any[] = await prisma.$queryRawUnsafe(
          'SELECT "tradeDate" AS d FROM daily_bars ORDER BY "tradeDate" DESC LIMIT 1'
        );
        if (mx.length && String(mx[0].d) === String(rows[0].d)) {
          return rows.map((r) => String(r.d));
        }
      }
    } catch {
      /* 表不存在/权限等 → 回退 daily_bars */
    }
    const rows: any[] = await prisma.$queryRawUnsafe(
      'SELECT DISTINCT "tradeDate" AS d FROM daily_bars ORDER BY "tradeDate" DESC LIMIT $1',
      limit
    );
    return rows.map((r) => String(r.d));
  }

  async loadMarketBreadth(tradeDate: string): Promise<MarketBreadthRow | null> {
    const rows: any[] = await prisma.$queryRawUnsafe(
      "SELECT trade_date, limit_up, limit_down FROM market_breadth WHERE trade_date <= $1 ORDER BY trade_date DESC LIMIT 1",
      tradeDate
    );
    if (!rows.length) return null;
    const r = rows[0];
    return {
      tradeDate: String(r.trade_date),
      limitUp: r.limit_up != null ? Number(r.limit_up) : null,
      limitDown: r.limit_down != null ? Number(r.limit_down) : null,
    };
  }

  /**
   * 全部在市非 ST 标的（含创业板/科创板），作为候选池。
   *
   * 2026-09-10：**取消 SQL 预筛**（原 prefilterCodes 已删除）。原因：
   *   预筛是「引擎规则的 SQL 手写副本」，引擎删门槛时漏改 → 静默丢掉 68% 的仙人指路信号
   *   （详见 docs/xianren-empty-day-postmortem.md）。取消后：
   *   ① 结构上不可能再出现「预筛比引擎严」这类静默漏报；
   *   ② 全市场已包含昨日/今日涨停标的，故「今日涨停池(fuyao)」「昨日涨停池(tushare)」
   *      两个候选补充不再需要，扫描关键路径少两个最坏 12s 的外部超时；
   *   ③ 实测端到端耗时不变（预筛自身 ~2.9s ≥ 它省下的载入 ~1s，见 config.ts 注释）。
   */
  async loadUniverseCodes(): Promise<PrefilterCode[]> {
    const rows: any[] = await prisma.$queryRawUnsafe(
      [
        "SELECT ts_code, name FROM stocks",
        "WHERE is_active = true",
        "  AND ts_code ~ '^(600|601|603|605|000|001|002|003|300|301|688|689)'",
        "  AND name !~ '(ST|退)'",
        "ORDER BY ts_code",
      ].join("\n")
    );
    return rows
      .map((r) => ({ tsCode: String(r.ts_code), name: r.name ? String(r.name) : "" }))
      .filter((r) => isMainBoardNonST(r.tsCode, r.name));
  }

  async loadSeriesForCodes(
    codes: PrefilterCode[],
    lookbackStart: string,
    endDate: string
  ): Promise<SeriesInput[]> {
    if (codes.length === 0) return [];
    const nameOf = new Map<string, string>();
    const codeList: string[] = [];
    for (const c of codes) {
      if (!nameOf.has(c.tsCode)) {
        nameOf.set(c.tsCode, c.name);
        codeList.push(c.tsCode);
      }
    }

    // 缓存命中：同一交易日内同窗口、同代码集合的 K 线完全不变，直接复用（省掉 ~4s 物化）
    const cacheKey = `${lookbackStart}|${endDate}|${codeList.length}|${codeList[0] ?? ""}|${codeList[codeList.length - 1] ?? ""}`;
    const cached = seriesCache.get(cacheKey);
    if (cached) return cached;

    const barRows: any[] = await prisma.$queryRawUnsafe(
      [
        "SELECT \"tsCode\" AS ts_code, \"tradeDate\" AS trade_date,",
        "       open, high, low, close, pre_close AS pre_close, vol, turnover_rate AS turnover_rate,",
        "       circ_mv AS circ_mv",
        "FROM daily_bars",
        "WHERE \"tsCode\" = ANY($1) AND \"tradeDate\" >= $2 AND \"tradeDate\" <= $3",
        "ORDER BY \"tsCode\", \"tradeDate\"",
      ].join("\n"),
      codeList,
      lookbackStart,
      endDate
    );

    const byCode = new Map<string, ShortBar[]>();
    for (const r of barRows) {
      if (r.open == null || r.high == null || r.low == null || r.close == null) continue;
      const code = String(r.ts_code);
      if (!byCode.has(code)) byCode.set(code, []);
      byCode.get(code)!.push({
        date: fmtDate(String(r.trade_date)),
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: Number(r.vol ?? 0),
        preClose: r.pre_close != null ? Number(r.pre_close) : null,
        turnoverRate: r.turnover_rate != null ? Number(r.turnover_rate) : null,
        circMv: r.circ_mv != null ? Number(r.circ_mv) : null,
      });
    }

    const out: SeriesInput[] = [];
    for (const [code, bars] of byCode) {
      if (bars.length < 2) continue;
      bars.sort((a, b) => (a.date < b.date ? -1 : 1));
      out.push({ tsCode: code, name: nameOf.get(code) ?? "", bars });
    }
    // 只保留最近一份：换交易日（或代码集合变化）即整份替换，稳态内存 ≈ 91MB
    seriesCache.clear();
    seriesCache.set(cacheKey, out);
    return out;
  }
}
