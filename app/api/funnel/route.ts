import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

/**
 * GET /api/funnel?days=60          分层筛选总览（最新一期 + 历史战绩 + 分年度）
 * GET /api/funnel?month=2026-09    某月每个交易日的入选数与表现（日历用）
 * GET /api/funnel?date=20260914    某一天选出的 5 只标的（日历点选后用）
 *
 * 数据来自 funnel_picks（由 scripts/funnel-backfill.ts 回填 / 日更写入）。
 * 当前库里没有这张表时返回空结构，前端显示空态，不报错。
 */

/** 入选明细的统一字段（总览与日历共用，避免两处 select 漂移） */
const PICK_COLS = `
  p.pick_date, p.rank_no, p.ts_code, p.name, p.reason,
  p.turnover_rate::float8 AS turnover_rate, p.turnover_q, p.past20::float8 AS past20,
  p.veto_hit, p.veto_types,
  p.ret5::float8 AS ret5, p.ret10::float8 AS ret10, p.ret20::float8 AS ret20,
  p.ex5::float8 AS ex5, p.ex10::float8 AS ex10, p.ex20::float8 AS ex20,
  p.settled,
  p.board_code, p.board_name, p.board_reason,
  p.llm_thesis, p.llm_counter`;

export async function GET(request: NextRequest) {
  const sp = new URL(request.url).searchParams;
  const month = sp.get('month');
  const date = sp.get('date');
  const days = Math.min(Math.max(Number(sp.get('days') ?? 60), 5), 500);

  try {
    const exists: any[] = await prisma.$queryRawUnsafe(
      `SELECT to_regclass('public.funnel_picks')::text AS t, to_regclass('public.funnel_runs')::text AS r`
    );
    if (!exists[0]?.t) {
      return NextResponse.json({ ready: false, latest: null, history: [], stats: null, byYear: [], days: [] });
    }

    // ---- 日历：某月逐日 ----
    if (month) {
      if (!/^\d{4}-\d{2}$/.test(month)) {
        return NextResponse.json({ error: 'month 格式应为 YYYY-MM' }, { status: 400 });
      }
      const rows: any[] = await prisma.$queryRawUnsafe(
        `SELECT pick_date,
                count(*)::int AS n,
                avg(ret5)::float8  AS ret5,
                avg(ret10)::float8 AS ret10,
                avg(ret20)::float8 AS ret20,
                avg(ex20)::float8  AS ex20,
                bool_and(settled)  AS settled
         FROM funnel_picks
         WHERE left(pick_date, 6) = $1
         GROUP BY pick_date ORDER BY pick_date`,
        month.replace('-', '')
      );
      return NextResponse.json({ ready: true, month, days: rows });
    }

    // ---- 日历：某一天的 5 只 ----
    if (date) {
      if (!/^\d{8}$/.test(date)) {
        return NextResponse.json({ error: 'date 格式应为 YYYYMMDD' }, { status: 400 });
      }
      const picks: any[] = await prisma.$queryRawUnsafe(
        `SELECT ${PICK_COLS} FROM funnel_picks p WHERE p.pick_date = $1 ORDER BY p.rank_no`,
        date
      );
      return NextResponse.json({ ready: true, date, picks });
    }

    // ---- 总览 ----
    const latestRows: any[] = await prisma.$queryRawUnsafe(`
      SELECT ${PICK_COLS}
      FROM funnel_picks p
      WHERE p.pick_date = (SELECT MAX(pick_date) FROM funnel_picks)
      ORDER BY p.rank_no
    `);
    const latestDate = latestRows[0]?.pick_date ?? null;
    const runRows: any[] = latestDate && exists[0]?.r
      ? await prisma.$queryRawUnsafe(
          `SELECT bar_date, veto_used, pick_count, note FROM funnel_runs WHERE pick_date = $1`, latestDate)
      : [];

    // 历史：每期日度等权
    const history: any[] = await prisma.$queryRawUnsafe(
      `
      SELECT pick_date,
             count(*)::int AS n,
             avg(ret5)::float8  AS ret5,
             avg(ret10)::float8 AS ret10,
             avg(ret20)::float8 AS ret20,
             avg(ex5)::float8   AS ex5,
             avg(ex10)::float8  AS ex10,
             avg(ex20)::float8  AS ex20,
             avg((ex20 > 0)::int)::float8 AS win20,
             bool_and(settled) AS settled
      FROM funnel_picks
      GROUP BY pick_date
      ORDER BY pick_date DESC
      LIMIT $1
      `,
      days
    );

    // 总体战绩（仅已定型样本）+ 实际数据范围
    //   ⚠️ 这里原来写死了 pick_date >= '20180101' 的「近段」口径。
    //      但生产库里根本没有 2018 年数据（分层筛选是新功能，回填只到 2025-09），
    //      于是「近段」等于全量，界面上却写着「2018 年起」—— 是**假信息**。
    //      现在改为**按真实数据范围**说话，不再假设库里有什么。
    const s: any[] = await prisma.$queryRawUnsafe(`
      SELECT count(DISTINCT pick_date)::int AS days,
             count(*)::int AS picks,
             avg(ret5)::float8  AS ret5,
             avg(ret10)::float8 AS ret10,
             avg(ret20)::float8 AS ret20,
             avg(ex5)::float8   AS ex5,
             avg(ex10)::float8  AS ex10,
             avg(ex20)::float8  AS ex20,
             avg((ex20 > 0)::int)::float8 AS win20,
             min(pick_date) AS date_from,
             max(pick_date) AS date_to
      FROM funnel_picks WHERE settled
    `);

    // 分年度
    const byYear: any[] = await prisma.$queryRawUnsafe(`
      SELECT left(pick_date, 4) AS yr,
             count(DISTINCT pick_date)::int AS days,
             avg(ex5)::float8  AS ex5,
             avg(ex10)::float8 AS ex10,
             avg(ex20)::float8 AS ex20,
             avg((ex20 > 0)::int)::float8 AS win20
      FROM funnel_picks WHERE settled
      GROUP BY 1 ORDER BY 1
    `);

    return NextResponse.json({
      ready: true,
      latest: latestDate
        ? { pickDate: latestDate, barDate: runRows[0]?.bar_date ?? latestDate, run: runRows[0] ?? null, picks: latestRows }
        : null,
      history,
      stats: s[0] ?? null,
      byYear,
    });
  } catch (e: any) {
    console.error('[api/funnel]', e);
    return NextResponse.json({ error: e.message || '查询失败' }, { status: 500 });
  }
}
