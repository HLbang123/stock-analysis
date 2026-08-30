/**
 * 短线策略 — 数据源（Prisma + raw SQL，遵守十年数据军规：日期边界 + 候选集预筛）
 *
 * 关键点：
 *  - daily_bars 列名陷阱："tsCode" / "tradeDate" 是 camelCase（raw SQL 带双引号），
 *    pre_close / turnover_rate 是 snake_case（裸用）。
 *  - 两段式取数：
 *    1) prefilterCodes：每套策略用「最小触发条件」在 SQL 层筛出可能命中的 ts_code，
 *       把候选从「近 120 日出现过涨停的几千只」压到「几十只」。
 *    2) loadSeriesForCodes：只拉这些 code 的完整回看窗口 K 线，交给引擎精算。
 *  - 日期双边界：start <= tradeDate <= end。
 */

import { prisma } from "@/lib/db";
import { isMainBoardNonST } from "@/lib/strategy/dragon-first-yin";
import { LIMIT_UP_CANDIDATE_PCT } from "./config";
import type { SeriesInput, ShortBar, ShortTermStrategyId } from "./types";

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
  prefilterCodes(strategy: ShortTermStrategyId, start: string, end: string): Promise<PrefilterCode[]>;
  loadSeriesForCodes(codes: PrefilterCode[], lookbackStart: string, endDate: string): Promise<SeriesInput[]>;
}

/** YYYYMMDD → YYYY-MM-DD */
export function fmtDate(d: string): string {
  return d && d.length === 8 ? d.slice(0, 4) + "-" + d.slice(4, 6) + "-" + d.slice(6, 8) : d;
}

/**
 * 前置筛选 CTE：对每个标的按 tradeDate 倒序编号 rn（rn=1 为窗口内最新交易日），
 * 窗口取「近 20 个交易日」即可覆盖各策略的最小触发窗口（含实时 bar 错位缓冲）。
 * $1/$2 = 前置窗口起止日期，$3 = 涨停候选阈值（change_pct >= 9.5 视作涨停超集）。
 */
const PREFILTER_CTE = [
  "WITH t AS (",
  '  SELECT db."tsCode" AS ts_code, db.change_pct, db.open, db.close, db.pre_close, db.high, db.low, s.name AS name,',
  '         ROW_NUMBER() OVER (PARTITION BY db."tsCode" ORDER BY db."tradeDate" DESC) AS rn',
  "  FROM daily_bars db",
  '  JOIN stocks s ON s.ts_code = db."tsCode"',
  '  WHERE db."tradeDate" >= $1 AND db."tradeDate" <= $2 AND s.is_active = true',
  ")",
].join("\n");

const PREFILTER_TAIL: Record<ShortTermStrategyId, string> = {
  // 涨停+三连阴：近 5 日内有涨停，且最新/次新两日都是真阴（close<open）。
  // 盘中实时 bar 尚未入库时，信号可能落在「今日(实时)」，此时 DB 只看到前两阴，故只卡最近两日收阴。
  "limit-up-three-yin": [
    "SELECT ts_code, MAX(name) AS name",
    "FROM t",
    "GROUP BY ts_code",
    "HAVING COUNT(*) FILTER (WHERE rn <= 5 AND change_pct >= $3) > 0",
    "   AND MAX(CASE WHEN rn = 1 AND close < open THEN 1 ELSE 0 END) = 1",
    "   AND MAX(CASE WHEN rn = 2 AND close < open THEN 1 ELSE 0 END) = 1",
  ].join("\n"),
  // 龙首阴：近 6 日内至少两次涨停（有连板段），且最新或次新日相对昨收下跌（真阴/假阴皆可）。
  "dragon-first-yin": [
    "SELECT ts_code, MAX(name) AS name",
    "FROM t",
    "GROUP BY ts_code",
    "HAVING COUNT(*) FILTER (WHERE rn <= 6 AND change_pct >= $3) >= 2",
    "   AND (MAX(CASE WHEN rn = 1 AND close < pre_close THEN 1 ELSE 0 END) = 1",
    "        OR MAX(CASE WHEN rn = 2 AND close < pre_close THEN 1 ELSE 0 END) = 1)",
  ].join("\n"),
  // 双龙战法：恰好二板；前置只要求近 6 日内至少两次涨停（连板段），引擎再精确判「恰好二板」。
  "double-dragon": [
    "SELECT ts_code, MAX(name) AS name",
    "FROM t",
    "GROUP BY ts_code",
    "HAVING COUNT(*) FILTER (WHERE rn <= 6 AND change_pct >= $3) >= 2",
  ].join("\n"),
  // 龙四阴：近 6 日内有涨停，且最近 3 日都收阴（第 4 阴为今日实时或 DB 最新，前 3 阴在 DB 可见）。
  "dragon-four-yin": [
    "SELECT ts_code, MAX(name) AS name",
    "FROM t",
    "GROUP BY ts_code",
    "HAVING COUNT(*) FILTER (WHERE rn <= 6 AND change_pct >= $3) > 0",
    "   AND MAX(CASE WHEN rn = 1 AND close < open THEN 1 ELSE 0 END) = 1",
    "   AND MAX(CASE WHEN rn = 2 AND close < open THEN 1 ELSE 0 END) = 1",
    "   AND MAX(CASE WHEN rn = 3 AND close < open THEN 1 ELSE 0 END) = 1",
  ].join("\n"),
  // 仙人指路：预筛只做「最小触发超集」，确认日的收盘位/反包交给引擎用实时 bar 精算。
  "xian-ren-zhi-lu": [
    "SELECT ts_code, MAX(name) AS name",
    "FROM t",
    "GROUP BY ts_code",
    "HAVING (",
    "  -- 今日确认 + 昨日试盘（今日日线已入库）",
    "  (MAX(CASE WHEN rn = 1 AND close >= pre_close AND close >= low + 0.6 * (high - low) THEN 1 ELSE 0 END) = 1",
    "   AND MAX(CASE WHEN rn = 2 AND (high - GREATEST(open, close)) >= 0.012 * open AND close >= pre_close AND low >= pre_close AND change_pct < $3 THEN 1 ELSE 0 END) = 1)",
    ") OR (",
    "  -- 昨日确认 + 前日试盘",
    "  (MAX(CASE WHEN rn = 2 AND close >= pre_close AND close >= low + 0.6 * (high - low) THEN 1 ELSE 0 END) = 1",
    "   AND MAX(CASE WHEN rn = 3 AND (high - GREATEST(open, close)) >= 0.012 * open AND close >= pre_close AND low >= pre_close AND change_pct < $3 THEN 1 ELSE 0 END) = 1)",
    ") OR (",
    "  -- 盘中：最新 DB 日(rn=1)就是试盘日，确认日=今日实时(未入库)，交由引擎用实时 bar 精算",
    "  (MAX(CASE WHEN rn = 1 AND (high - GREATEST(open, close)) >= 0.012 * open AND close >= pre_close AND low >= pre_close AND change_pct < $3 THEN 1 ELSE 0 END) = 1)",
    ")",
  ].join("\n"),
};

export class PrismaShortTermDataSource implements ShortTermDataSource {
  async getLatestTradeDate(): Promise<string | null> {
    const rows: any[] = await prisma.$queryRawUnsafe(
      'SELECT "tradeDate" FROM daily_bars ORDER BY "tradeDate" DESC LIMIT 1'
    );
    return rows.length ? String(rows[0].tradeDate) : null;
  }

  async getTradeDates(count: number): Promise<string[]> {
    const limit = Math.max(1, Math.floor(count));
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

  async prefilterCodes(
    strategy: ShortTermStrategyId,
    start: string,
    end: string
  ): Promise<PrefilterCode[]> {
    const sql = PREFILTER_CTE + "\n" + PREFILTER_TAIL[strategy];
    const rows: any[] = await prisma.$queryRawUnsafe(sql, start, end, LIMIT_UP_CANDIDATE_PCT);
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

    const barRows: any[] = await prisma.$queryRawUnsafe(
      [
        "SELECT \"tsCode\" AS ts_code, \"tradeDate\" AS trade_date,",
        "       open, high, low, close, pre_close AS pre_close, vol, turnover_rate AS turnover_rate",
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
      });
    }

    const out: SeriesInput[] = [];
    for (const [code, bars] of byCode) {
      if (bars.length < 2) continue;
      bars.sort((a, b) => (a.date < b.date ? -1 : 1));
      out.push({ tsCode: code, name: nameOf.get(code) ?? "", bars });
    }
    return out;
  }
}
