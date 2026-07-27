/**
 * AI 筛选 — L1 候选池拉取
 *
 * SQL 做基本硬筛（RPS/成交额/价格/涨跌幅/ST/60日涨幅），并用 array_agg 一次性
 * 拉回每只候选近 60 根 OHLCV 序列 + 基本面 + 行业指数涨幅。
 * 技术类硬筛（波动率/回撤/MA 多头）需序列，放到 TS 侧 enrich 后执行。
 */

import { prisma } from '@/lib/db';
import type { CandidateRaw, HardFilterConfig, StrategyPreset } from './types';

const RPS_COLS: Record<number, string> = { 20: 'rps_20', 60: 'rps_60', 120: 'rps_120', 250: 'rps_250' };

/** 把 HardFilterConfig 拆成 SQL 可执行的片段 + TS 侧待筛标志 */
function buildWhere(hf: HardFilterConfig): { sql: string[]; params: (string | number)[] } {
  const sql: string[] = [];
  const params: (string | number)[] = [];
  const push = (clause: string, val?: string | number) => {
    sql.push(clause);
    if (val !== undefined) params.push(val);
  };

  if (hf.excludeSt) sql.push(`s.name NOT ILIKE '%ST%'`);
  if (hf.rpsMin != null) {
    const col = RPS_COLS[hf.rpsPeriod ?? 60] ?? 'rps_60';
    push(`r.${col} >= $${params.length + 1}`, hf.rpsMin);
  }
  if (hf.amountMin != null) {
    // daily_bars.amount 单位千元 → 换算
    push(`db.amount * 1000 >= $${params.length + 1}`, hf.amountMin);
  }
  if (hf.priceMin != null) push(`db.close >= $${params.length + 1}`, hf.priceMin);
  if (hf.priceMax != null) push(`db.close <= $${params.length + 1}`, hf.priceMax);
  if (hf.changePctMin != null) push(`db.change_pct >= $${params.length + 1}`, hf.changePctMin);
  if (hf.changePctMax != null) push(`db.change_pct <= $${params.length + 1}`, hf.changePctMax);
  if (hf.change60dMin != null) push(`r.ret_60 >= $${params.length + 1}`, hf.change60dMin);
  if (hf.change60dMax != null) push(`r.ret_60 <= $${params.length + 1}`, hf.change60dMax);

  return { sql, params };
}

export interface CandidateFetchResult {
  barDate: string;
  calcDate: string;
  candidates: CandidateRaw[];
}

export async function fetchCandidates(preset: StrategyPreset): Promise<CandidateFetchResult> {
  const hf = preset.hardFilters;
  const period = hf.rpsPeriod ?? 60;
  const rpsCol = RPS_COLS[period] ?? 'rps_60';

  const latestBar = await prisma.dailyBar.findFirst({ orderBy: { tradeDate: 'desc' }, select: { tradeDate: true } });
  const latestRps = await prisma.rpsScore.findFirst({ orderBy: { calcDate: 'desc' }, select: { calcDate: true } });
  if (!latestBar || !latestRps) throw new Error('无可用日线/RPS 数据');

  const barDate = latestBar.tradeDate;
  const calcDate = latestRps.calcDate;

  // 序列窗口：近 90 日历日 ≈ 60 交易日
  const start = new Date();
  start.setDate(start.getDate() - 90);
  const startDate = start.toISOString().slice(0, 10).replace(/-/g, '');

  const { sql: whereSql, params } = buildWhere(hf);
  const whereClause = ['s.is_active = true', ...whereSql].join(' AND ');

  // 参数顺序：calcDate, startDate, barDate, ...where params
  const allParams: (string | number)[] = [calcDate, startDate, barDate, ...params];

  const query = `
    WITH cand AS (
      SELECT s.ts_code, s.name, s.industry,
             r.${rpsCol} AS rps, r.ret_60 AS ret60d,
             db.close, db.change_pct, db.vol, db.amount
      FROM stocks s
      JOIN rps_scores r ON r.ts_code = s.ts_code AND r.calc_date = $1
      JOIN daily_bars db ON db.ts_code = s.ts_code AND db.trade_date = $3
      WHERE ${whereClause}
    )
    SELECT c.ts_code, c.name, c.industry, c.rps, c.ret60d,
           c.close, c.change_pct, c.vol, c.amount,
           f.roe, f.grossprofit_margin, f.or_yoy,
           ind.pct_chg AS industry_change_pct,
           array_agg(d.close ORDER BY d.trade_date) AS closes,
           array_agg(d.high ORDER BY d.trade_date) AS highs,
           array_agg(d.low ORDER BY d.trade_date) AS lows,
           array_agg(d.vol ORDER BY d.trade_date) AS vols
    FROM cand c
    LEFT JOIN stock_fundamentals f ON f.ts_code = c.ts_code
    LEFT JOIN LATERAL (
      SELECT m.index_code FROM sw_index_member m
      WHERE m.member_code = c.ts_code AND m.index_level = 'L1' LIMIT 1
    ) m ON true
    LEFT JOIN sw_index_daily ind ON ind.ts_code = m.index_code AND ind.trade_date = $3
    LEFT JOIN daily_bars d ON d.ts_code = c.ts_code AND d.trade_date >= $2
    GROUP BY c.ts_code, c.name, c.industry, c.rps, c.ret60d,
             c.close, c.change_pct, c.vol, c.amount,
             f.roe, f.grossprofit_margin, f.or_yoy, ind.pct_chg
    ORDER BY c.rps DESC NULLS LAST
    LIMIT 200
  `;

  const rows = await prisma.$queryRawUnsafe<any[]>(query, ...allParams);

  const candidates: CandidateRaw[] = rows.map((r) => ({
    tsCode: r.ts_code,
    name: r.name,
    industry: r.industry,
    rps: r.rps != null ? Number(r.rps) : null,
    ret60d: r.ret60d != null ? Number(r.ret60d) : null,
    latestClose: r.close != null ? Number(r.close) : null,
    latestChange: r.change_pct != null ? Number(r.change_pct) : null,
    latestVol: r.vol != null ? Number(r.vol) : null,
    latestAmount: r.amount != null ? Number(r.amount) * 1000 : null, // 千元 → 元
    roe: r.roe != null ? Number(r.roe) : null,
    grossprofitMargin: r.grossprofit_margin != null ? Number(r.grossprofit_margin) : null,
    orYoy: r.or_yoy != null ? Number(r.or_yoy) : null,
    industryChangePct: r.industry_change_pct != null ? Number(r.industry_change_pct) : null,
    closes: Array.isArray(r.closes) ? (r.closes as any[]).map((x) => Number(x)).filter((x: number) => Number.isFinite(x)) : [],
    highs: Array.isArray(r.highs) ? (r.highs as any[]).map((x) => Number(x)).filter((x: number) => Number.isFinite(x)) : [],
    lows: Array.isArray(r.lows) ? (r.lows as any[]).map((x) => Number(x)).filter((x: number) => Number.isFinite(x)) : [],
    vols: Array.isArray(r.vols) ? (r.vols as any[]).map((x) => Number(x)).filter((x: number) => Number.isFinite(x)) : [],
  }));

  return { barDate, calcDate, candidates };
}
