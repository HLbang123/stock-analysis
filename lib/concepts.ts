/**
 * 同花顺概念板块数据服务（板块口径单一事实源）
 *
 * 数据来自 ths_index / ths_index_member（fuyao sync-ths-index 维护，cn_concept 概念 + industry 行业）。
 * 与申万口径（sw_index_member）不同：概念是多对多、更聚焦（约 390 个），
 * 更贴近「热门板块」的日常语义。扫描器/AI 筛选/RPS 的板块筛选统一走这里。
 */

import { prisma } from "@/lib/db";

export interface ConceptInfo {
  thscode: string;
  name: string;
  count: number; // 活跃成分数
}

/** 同花顺概念板块清单（含活跃成分数），供板块选择下拉。 */
export async function listConcepts(): Promise<ConceptInfo[]> {
  const rows: any[] = await prisma.$queryRawUnsafe(`
    SELECT i.thscode, i.name, COUNT(DISTINCT m.ts_code)::int AS count
    FROM ths_index i
    JOIN ths_index_member m ON m.thscode = i.thscode
    JOIN stocks s ON m.ts_code = s.ts_code AND s.is_active = true
    WHERE i.tag = 'cn_concept' AND i.name IS NOT NULL
    GROUP BY i.thscode, i.name
    ORDER BY count DESC, i.name
  `);
  return rows.map((r) => ({ thscode: String(r.thscode), name: String(r.name), count: Number(r.count) }));
}

/** 某只票所属的概念板块 thscode 列表（多对多）。 */
export async function conceptsOfStock(tsCode: string): Promise<string[]> {
  const rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT m.thscode FROM ths_index_member m
     JOIN ths_index i ON i.thscode = m.thscode
     WHERE i.tag = 'cn_concept' AND m.ts_code = $1`,
    tsCode
  );
  return rows.map((r) => String(r.thscode));
}

/** 概念成分 ts_code 列表（活跃），供 SQL 过滤。 */
export async function listConceptMembersByName(name: string): Promise<string[]> {
  const rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT m.ts_code FROM ths_index_member m
     JOIN ths_index i ON i.thscode = m.thscode
     JOIN stocks s ON m.ts_code = s.ts_code AND s.is_active = true
     WHERE i.tag = 'cn_concept' AND i.name = $1`,
    name
  );
  return rows.map((r) => String(r.ts_code));
}

/** 概念成分数（活跃）。 */
export async function conceptMemberCount(thscode: string): Promise<number> {
  const rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT COUNT(DISTINCT m.ts_code)::int AS c
     FROM ths_index_member m
     JOIN stocks s ON m.ts_code = s.ts_code AND s.is_active = true
     WHERE m.thscode = $1`,
    thscode
  );
  return rows[0]?.c ? Number(rows[0].c) : 0;
}

/**
 * 板块仙人指路（简单版）：概念板块指数 T-1 留长上影（冲高回落）+ T 收盘反包上影线 ≥50%。
 * 取 ths_index_daily 最新交易日为 T，返回命中的概念 thscode 集合（cn_concept）。
 * 回测口径（2024-08 至今，全量同花顺概念指数）：上影≥1.5% 且反包上影≥50%，板块次日 +0.86%、胜率 62.2%。
 * 反包 50% 比「站上昨高」更贴合「反包上影线」语义，且不漏掉「收复大部分上影但未创新高」的案例。
 */
export async function computeSectorXianRenCodes(shadowMinPct = 1.5, coverMinRatio = 0.5): Promise<Set<string>> {
  const rows: any[] = await prisma.$queryRawUnsafe(
    `WITH b AS (
      SELECT ts_code, trade_date, open, high, low, close,
        LAG(open) OVER w AS p_open,
        LAG(high) OVER w AS p_high,
        LAG(close) OVER w AS p_close
      FROM ths_index_daily
      WINDOW w AS (PARTITION BY ts_code ORDER BY trade_date)
    ), latest AS (
      SELECT trade_date FROM ths_index_daily ORDER BY trade_date DESC LIMIT 1
    )
    SELECT b.ts_code
    FROM b
    JOIN ths_index i ON i.thscode = b.ts_code AND i.tag = 'cn_concept'
    WHERE b.trade_date = (SELECT trade_date FROM latest)
      AND b.p_high IS NOT NULL AND b.p_close > 0
      AND b.p_high > GREATEST(b.p_open, b.p_close)
      AND b.close >= b.p_close + (b.p_high - b.p_close) * $2
      AND (b.p_high - GREATEST(b.p_open, b.p_close)) / b.p_close * 100 >= $1`,
    shadowMinPct,
    coverMinRatio
  );
  return new Set(rows.map((r) => String(r.ts_code)));
}

/** 板块仙人指路详情（单票聚合）：命中板块数、最强上影、最强命中板块 T 日量比。
 *  供仙人指路打分的三个板块维度（多概念共振/反包强度/缩量反包）使用。
 *  口径与回测一致：概念指数 T-1 上影≥1.5% 且 T 反包上影≥50% 记一次命中。 */
export interface SectorXianRenStat {
  hitCount: number;         // 命中板块数
  maxShadow: number;        // 最强命中板块的 T-1 上影幅度 %
  volRatioT: number | null; // 最强命中板块的 T 日量比（T vol / 前5日均量）
}

export interface SectorXianRenResult {
  stats: Map<string, SectorXianRenStat>;
  /** 板块库里最新的交易日 YYYYMMDD（无数据为 null）。调用方据此判断板块数据是否跟得上，
   *  避免拿滞后几天的板块形态给今天的信号打分（口径也就与回测不一致了）。 */
  latestTradeDate: string | null;
}

/** 板块共振统计的进程内缓存：同交易日内结果恒定（板块数据 EOD 才更新），
 *  按「锚定日 + 参数」做 key 自动失效，另加 TTL 兜底防同日回补数据。
 *  TTL 取 6 小时：数据全天不变，key 带锚定日已防跨日串味；原 10 分钟太短，
 *  用户隔一阵点一次扫描就会撞上重算（冷 5~10s）。 */
const SECTOR_STATS_TTL_MS = 6 * 60 * 60 * 1000;
const SECTOR_STATS_CACHE_MAX = 8;
const sectorStatsCache = new Map<string, { at: number; value: SectorXianRenResult }>();

/**
 * @param asOf 锚定日 YYYYMMDD（库内最新交易日）。既做日期下界锚点，也做缓存 key。
 *   传入它可以避免 `max(trade_date)` 全表并行扫（实测 650ms，该表只有 (ts_code,trade_date) 主键）。
 */
export async function computeSectorXianRenStatsByStock(
  asOf: string,
  shadowMinPct = 1.5,
  coverMinRatio = 0.5
): Promise<SectorXianRenResult> {
  const cacheKey = `${asOf}|${shadowMinPct}|${coverMinRatio}`;
  const cached = sectorStatsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < SECTOR_STATS_TTL_MS) return cached.value;

  // 1. 板块指数最近 8 个交易日（够算 T/T-1 上影反包 + T 日前5日均量），cn_concept
  const sectorRows: any[] = await prisma.$queryRawUnsafe(
    `WITH ranked AS (
      SELECT d.ts_code, d.trade_date, d.open, d.high, d.close, d.vol,
        ROW_NUMBER() OVER (PARTITION BY d.ts_code ORDER BY d.trade_date DESC) AS rn
      FROM ths_index_daily d
      JOIN ths_index i ON i.thscode = d.ts_code AND i.tag = 'cn_concept'
      -- 日期下界：否则窗口函数要排全历史（288万行），实测 2.6s → 加下界后走 (ts_code,trade_date) 主键
      -- 取 40 个自然日（≈25 个交易日），长假也不会不足 8 根
      WHERE d.trade_date >= to_char($1::date - interval '40 days', 'YYYYMMDD')
    )
    SELECT ts_code, trade_date, open, high, close, vol
    FROM ranked WHERE rn <= 8
    ORDER BY ts_code, trade_date`,
    asOf
  );
  const byCode = new Map<string, { trade_date: string; open: number; high: number; close: number; vol: number }[]>();
  for (const r of sectorRows) {
    if (r.open == null || r.high == null || r.close == null) continue;
    if (!byCode.has(r.ts_code)) byCode.set(r.ts_code, []);
    byCode.get(r.ts_code)!.push({
      trade_date: String(r.trade_date), open: Number(r.open), high: Number(r.high),
      close: Number(r.close), vol: Number(r.vol ?? 0),
    });
  }
  // 2. 每个板块命中判定 + 上影 + T 日量比
  const hitStat = new Map<string, { shadow: number; volRatioT: number | null }>();
  for (const [code, bars] of byCode) {
    if (bars.length < 7) continue;
    const t = bars[bars.length - 1];       // 最新交易日 T
    const t0 = bars[bars.length - 2];      // T-1
    const shadowTop = Math.max(t0.open, t0.close);
    if (!(t0.high > shadowTop) || t0.close <= 0) continue;
    const shadowPct = ((t0.high - shadowTop) / t0.close) * 100;
    if (shadowPct < shadowMinPct) continue;
    if (t.close < t0.close + (t0.high - t0.close) * coverMinRatio) continue;
    let volRatioT: number | null = null;
    const prev5 = bars.slice(-6, -1).map((b) => b.vol).filter((v) => v > 0);
    if (prev5.length >= 3) {
      const avg = prev5.reduce((a, b) => a + b, 0) / prev5.length;
      if (avg > 0) volRatioT = Math.round((t.vol / avg) * 100) / 100;
    }
    hitStat.set(code, { shadow: shadowPct, volRatioT });
  }
  // 3. 概念成分映射，聚合到每只股票
  const memberRows: any[] = await prisma.$queryRawUnsafe(
    `SELECT m.thscode, m.ts_code FROM ths_index_member m
     JOIN ths_index i ON i.thscode = m.thscode WHERE i.tag = 'cn_concept'`
  );
  const out = new Map<string, SectorXianRenStat>();
  for (const m of memberRows) {
    const ths = String(m.thscode), ts = String(m.ts_code);
    if (!ths || !ts) continue;
    const hs = hitStat.get(ths);
    if (!hs) continue;
    const cur = out.get(ts);
    if (!cur) {
      out.set(ts, { hitCount: 1, maxShadow: hs.shadow, volRatioT: hs.volRatioT });
    } else {
      cur.hitCount += 1;
      if (hs.shadow > cur.maxShadow) {
        cur.maxShadow = hs.shadow;
        cur.volRatioT = hs.volRatioT;
      }
    }
  }
  // 板块库里最新交易日（行集已覆盖最近 40 个自然日，取最大值即板块数据的截止日）
  let latestTradeDate: string | null = null;
  for (const r of sectorRows) {
    const d = String(r.trade_date ?? "");
    if (d && (!latestTradeDate || d > latestTradeDate)) latestTradeDate = d;
  }
  const result: SectorXianRenResult = { stats: out, latestTradeDate };
  if (sectorStatsCache.size >= SECTOR_STATS_CACHE_MAX) sectorStatsCache.clear();
  sectorStatsCache.set(cacheKey, { at: Date.now(), value: result });
  return result;
}

/** 根据当天涨停票集合，计算每只票「最热概念」的涨停密度（概念内涨停数/成分数，取最大值）。 */
export async function computeConceptDensityByStock(limitUpCodes: string[]): Promise<Map<string, number>> {
  const rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT m.thscode, m.ts_code FROM ths_index_member m
     JOIN ths_index i ON i.thscode = m.thscode
     WHERE i.tag = 'cn_concept'`
  );
  const stockToConcepts = new Map<string, string[]>();
  const conceptCount = new Map<string, number>();
  for (const r of rows) {
    const ths = String(r.thscode), ts = String(r.ts_code);
    if (!ths || !ts) continue;
    conceptCount.set(ths, (conceptCount.get(ths) ?? 0) + 1);
    const arr = stockToConcepts.get(ts);
    if (arr) arr.push(ths);
    else stockToConcepts.set(ts, [ths]);
  }
  const limitUpSet = new Set(limitUpCodes);
  const conceptLimitUp = new Map<string, number>();
  for (const ts of limitUpSet) {
    const concepts = stockToConcepts.get(ts);
    if (!concepts) continue;
    for (const c of concepts) conceptLimitUp.set(c, (conceptLimitUp.get(c) ?? 0) + 1);
  }
  const out = new Map<string, number>();
  for (const [ts, concepts] of stockToConcepts) {
    let maxD = 0;
    for (const c of concepts) {
      const cnt = conceptCount.get(c) ?? 0;
      const lu = conceptLimitUp.get(c) ?? 0;
      if (cnt > 0 && lu > 0) {
        const d = lu / cnt;
        if (d > maxD) maxD = d;
      }
    }
    out.set(ts, maxD);
  }
  return out;
}
