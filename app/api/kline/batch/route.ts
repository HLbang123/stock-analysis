import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { normalizeMarketCode } from '@/lib/api-helpers';

const MAX_CODES = 400;
const MAX_DAYS = 250;

/**
 * 批量日K — GET /api/kline/batch?codes=sh600519,sz000001&days=120
 * 数据来自 daily_bars（本地 DB，一条窗口函数 SQL），前复权口径：
 *   qfq价 = 原始价 × adj_factor / 该票最新 adj_factor（与上游腾讯 qfq 对齐）
 * 响应 { klines: { [code]: KLineData[] } }；DB 无覆盖的品种（ETF/北交所等）不出现，
 * 调用方对缺失代码自行回落上游单只拉取。
 *
 * 背景（2026-08-17）：自选页 MA 交叉徽标 / 首页预警检查原按"每只一次 /api/kline"
 * 打上游，400+ 自选 → 每人每次访问 400+ 次出站请求；改由 DB 批量出数后上游 0 次。
 */
export async function GET(request: NextRequest) {
  const days = Math.min(parseInt(request.nextUrl.searchParams.get('days') || '120') || 120, MAX_DAYS);
  const raw = (request.nextUrl.searchParams.get('codes') || '').split(',');

  // sina 口径(sh600519) → tushare 口径(600519.SH)；格式强校验后内联（防注入）
  const pairs: { sina: string; tushare: string }[] = [];
  const seen = new Set<string>();
  for (const c of raw) {
    const parsed = normalizeMarketCode(c.trim().toLowerCase());
    if (!parsed) continue;
    const sina = `${parsed.market}${parsed.pureCode}`;
    const tushare = `${parsed.pureCode}.${parsed.market.toUpperCase()}`;
    if (seen.has(sina) || !/^\d{6}\.(SH|SZ|BJ)$/.test(tushare)) continue;
    seen.add(sina);
    pairs.push({ sina, tushare });
    if (pairs.length >= MAX_CODES) break;
  }
  if (pairs.length === 0) {
    return NextResponse.json({ error: '缺少有效 codes 参数' }, { status: 400 });
  }

  try {
    const list = pairs.map((p) => `'${p.tushare}'`).join(',');
    // 日期下界：2026-08-17 修复——旧版无下界，窗口函数要读每票全部历史（10年回补后 400票×2350天≈94万行/请求）。
    // days 是交易日数，×2 日历日余量覆盖周末/长假/数据滞后（250交易日≈365日历日，2x=500 足够）
    const cutoffD = new Date();
    cutoffD.setDate(cutoffD.getDate() - days * 2);
    const cutoff = cutoffD.toISOString().slice(0, 10).replace(/-/g, '');
    const rows = await prisma.$queryRawUnsafe<{
      tsCode: string; tradeDate: string;
      open: number | null; high: number | null; low: number | null; close: number | null;
      vol: number | null; adjFactor: number | null; latestFactor: number | null;
    }[]>(`
      SELECT "tsCode", "tradeDate", open, high, low, close, vol,
             adj_factor AS "adjFactor", "latestFactor"
      FROM (
        SELECT "tsCode", "tradeDate", open, high, low, close, vol, adj_factor,
               ROW_NUMBER() OVER (PARTITION BY "tsCode" ORDER BY "tradeDate" DESC) AS rn,
               FIRST_VALUE(adj_factor) OVER (PARTITION BY "tsCode" ORDER BY "tradeDate" DESC) AS "latestFactor"
        FROM daily_bars
        WHERE "tsCode" IN (${list}) AND "tradeDate" >= '${cutoff}'
      ) t
      WHERE rn <= ${days}
      ORDER BY "tsCode", "tradeDate" ASC
    `);

    const sinaOf = new Map(pairs.map((p) => [p.tushare, p.sina]));
    const klines: Record<string, { date: string; open: number; high: number; low: number; close: number; volume: number }[]> = {};
    const round3 = (n: number) => Math.round(n * 1000) / 1000;
    for (const r of rows) {
      if (r.open == null || r.close == null) continue;
      const sina = sinaOf.get(r.tsCode);
      if (!sina) continue;
      // adj_factor 缺失（回补未完成）退化为原始价，与 compute-rps 口径一致
      const f = r.adjFactor && r.latestFactor && r.latestFactor > 0 ? r.adjFactor / r.latestFactor : 1;
      const d = r.tradeDate;
      (klines[sina] ??= []).push({
        date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
        open: round3(r.open * f),
        high: round3((r.high ?? r.open) * f),
        low: round3((r.low ?? r.open) * f),
        close: round3(r.close * f),
        volume: Math.round(r.vol ?? 0), // tushare vol 单位=手，与上游腾讯日K一致
      });
    }

    return NextResponse.json({ klines });
  } catch (e: any) {
    console.error('[api/kline/batch]', e);
    return NextResponse.json({ error: e.message || '查询失败' }, { status: 500 });
  }
}
