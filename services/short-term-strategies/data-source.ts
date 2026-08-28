/**
 * 短线策略 — 数据源（Prisma + raw SQL，遵守十年数据军规：日期边界 + 候选集预筛）
 *
 * 关键点：
 *  - daily_bars 列名陷阱："tsCode" / "tradeDate" 是 camelCase（raw SQL 带双引号），
 *    pre_close / turnover_rate 是 snake_case（裸用）。
 *  - 候选集预筛：只用 change_pct >= 9.5 的标的（涨停候选超集），再在 JS 里用
 *    isMainBoardNonST 精确过滤主板非 ST，避免全市场拉全历史。
 *  - 日期双边界：lookbackStart <= tradeDate <= endDate。
 */

import { prisma } from "@/lib/db";
import { isMainBoardNonST } from "@/lib/strategy/dragon-first-yin";
import { LIMIT_UP_CANDIDATE_PCT } from "./config";
import type { SeriesInput, ShortBar } from "./types";

export interface MarketBreadthRow {
  tradeDate: string;
  limitUp: number | null;
  limitDown: number | null;
}

export interface ShortTermDataSource {
  getLatestTradeDate(): Promise<string | null>;
  getTradeDates(count: number): Promise<string[]>; // 降序 YYYYMMDD
  loadMarketBreadth(tradeDate: string): Promise<MarketBreadthRow | null>;
  loadCandidateSeries(lookbackStart: string, endDate: string): Promise<SeriesInput[]>;
}

/** YYYYMMDD → YYYY-MM-DD */
export function fmtDate(d: string): string {
  return d && d.length === 8 ? d.slice(0, 4) + "-" + d.slice(4, 6) + "-" + d.slice(6, 8) : d;
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

  async loadCandidateSeries(lookbackStart: string, endDate: string): Promise<SeriesInput[]> {
    // 1) 候选集：窗口内出现过涨停（change_pct >= 9.5）且 is_active 的标的
    const candRows: any[] = await prisma.$queryRawUnsafe(
      [
        "SELECT DISTINCT db.\"tsCode\" AS ts_code, s.name AS name",
        "FROM daily_bars db",
        "JOIN stocks s ON s.ts_code = db.\"tsCode\"",
        "WHERE db.\"tradeDate\" >= $1 AND db.\"tradeDate\" <= $2",
        "  AND db.change_pct >= $3",
        "  AND s.is_active = true",
      ].join("\n"),
      lookbackStart,
      endDate,
      LIMIT_UP_CANDIDATE_PCT
    );

    const codes = candRows
      .filter((r) => isMainBoardNonST(String(r.ts_code), r.name ?? null))
      .map((r) => String(r.ts_code));
    const nameOf = new Map<string, string>();
    for (const r of candRows) nameOf.set(String(r.ts_code), r.name ?? "");

    if (codes.length === 0) return [];

    // 2) 拉取候选集窗口内日线（带日期双边界）
    const barRows: any[] = await prisma.$queryRawUnsafe(
      [
        "SELECT \"tsCode\" AS ts_code, \"tradeDate\" AS trade_date,",
        "       open, high, low, close, pre_close AS pre_close, vol, turnover_rate AS turnover_rate",
        "FROM daily_bars",
        "WHERE \"tsCode\" = ANY($1) AND \"tradeDate\" >= $2 AND \"tradeDate\" <= $3",
        "ORDER BY \"tsCode\", \"tradeDate\"",
      ].join("\n"),
      codes,
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
