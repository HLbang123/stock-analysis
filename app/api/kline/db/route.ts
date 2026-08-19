import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { normalizeMarketCode } from '@/lib/api-helpers';

const MAX_DAYS = 1000;

/**
 * 单只日K（历史段，T-1 及以前）— GET /api/kline/db?code=sh600519&days=120
 * 数据来自 daily_bars（本地 DB），前复权现算，口径与 /api/kline/batch 一致：
 *   qfq价 = 原始价 × adj_factor / 该票最新 adj_factor（与上游腾讯 qfq 对齐）
 *
 * 响应 { bars: KLineData[], adjFactorCovered: boolean }：
 *   - bars 不含今日（DB 为 T-1 快照），今日 bar 由调用方用实时行情合成后拼入。
 *   - adjFactorCovered=false 表示该票在窗口内复权因子缺失（backfill-adj 未跑完）或
 *     无覆盖（ETF/北交所等）——此时 bars 会退化为原始价/空，调用方须回落上游单只拉取。
 *
 * 背景（2026-08-19）：详情页日K原走 /api/kline 打腾讯/东财/新浪，与 AI 分析/RPS 吃的
 * daily_bars 是两条独立来源，价格可能对不齐；改为历史段直读 DB，今日 bar 仍走实时行情。
 */
export async function GET(request: NextRequest) {
  const days = Math.min(parseInt(request.nextUrl.searchParams.get('days') || '120') || 120, MAX_DAYS);
  const code = (request.nextUrl.searchParams.get('code') || '').trim().toLowerCase();

  const parsed = normalizeMarketCode(code);
  if (!parsed) {
    return NextResponse.json({ error: '缺少有效 code 参数' }, { status: 400 });
  }
  const tushare = `${parsed.pureCode}.${parsed.market.toUpperCase()}`;
  if (!/^\d{6}\.(SH|SZ|BJ)$/.test(tushare)) {
    return NextResponse.json({ error: '缺少有效 code 参数' }, { status: 400 });
  }

  // 日期下界（同 batch：days 交易日 × 2 日历日余量覆盖周末/长假/数据滞后）
  const cutoffD = new Date();
  cutoffD.setDate(cutoffD.getDate() - days * 2);
  const cutoff = cutoffD.toISOString().slice(0, 10).replace(/-/g, '');

  try {
    const rows = await prisma.$queryRawUnsafe<
      {
        tradeDate: string;
        open: number | null;
        high: number | null;
        low: number | null;
        close: number | null;
        vol: number | null;
        adjFactor: number | null;
        latestFactor: number | null;
      }[]
    >(
      `
      SELECT "tradeDate", open, high, low, close, vol, adj_factor AS "adjFactor", "latestFactor"
      FROM (
        SELECT "tradeDate", open, high, low, close, vol, adj_factor,
               ROW_NUMBER() OVER (ORDER BY "tradeDate" DESC) AS rn,
               FIRST_VALUE(adj_factor) OVER (ORDER BY "tradeDate" DESC) AS "latestFactor"
        FROM daily_bars
        WHERE "tsCode" = $1 AND "tradeDate" >= $2
      ) t
      WHERE rn <= $3
      ORDER BY "tradeDate" ASC
      `,
      tushare,
      cutoff,
      days
    );

    // 复权覆盖判定：窗口内每根都有 adj_factor 且最新因子有效才算「已回补」；
    // 任一缺失（backfill 未跑完）会退化为原始价，和上游 qfq 对不齐，须回落上游。
    const adjFactorCovered =
      rows.length > 0 &&
      rows.every((r) => r.adjFactor != null && r.latestFactor != null && r.latestFactor > 0);

    const round3 = (n: number) => Math.round(n * 1000) / 1000;
    const bars = rows
      .filter((r) => r.open != null && r.close != null)
      .map((r) => {
        const f = r.adjFactor && r.latestFactor && r.latestFactor > 0 ? r.adjFactor / r.latestFactor : 1;
        const d = r.tradeDate;
        return {
          date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
          open: round3(r.open! * f),
          high: round3((r.high ?? r.open!) * f),
          low: round3((r.low ?? r.open!) * f),
          close: round3(r.close! * f),
          volume: Math.round(r.vol ?? 0), // tushare vol 单位=手，与上游腾讯日K一致
        };
      });

    return NextResponse.json({ bars, adjFactorCovered });
  } catch (e: any) {
    console.error('[api/kline/db]', e);
    return NextResponse.json({ error: e.message || '查询失败' }, { status: 500 });
  }
}
