import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { isActiveSignal, SELL_RULE_IDS } from '@/services/alertRules';

/**
 * C1：预警规则 × 周期 regime 方向命中率（只读，展示子集）。
 * - 方向感知口径（与 SELL_RULE_IDS 同源）：卖出侧(R01/R02/R03/R14)命中 = t5_return < 0；
 *   买入侧命中 = t5_return > 0。
 * - 只回 defense/neutral 稳健对比 + 窗口 + 各 regime 日级簇天数（attack 日级簇不足时由 UI 标「样本不足」）。
 * - 只读：不动触发逻辑、不改阈值、不做优先级调整/救回禁用。
 */
export async function GET(request: NextRequest) {
  try {
    // 与预警规则健康表同窗口，避免全表 join alert_rule_triggers（10 年数据会拖慢打开）
    const days = parseInt(new URL(request.url).searchParams.get('days') || '180');
    const since = new Date(Date.now() - days * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(/-/g, '');

    const win = await prisma.$queryRawUnsafe<{ mn: string | null; mx: string | null }[]>(
      "SELECT min(bar_date) AS mn, max(bar_date) AS mx FROM alert_rule_triggers WHERE t5_return IS NOT NULL AND bar_date >= $1",
      since
    );
    const mn = win[0].mn, mx = win[0].mx;
    if (!mn || !mx) return NextResponse.json({ window: { min: null, max: null }, regimeDays: {}, rows: [] });

    const regimeDaysRows = await prisma.$queryRawUnsafe<{ regime: string | null; days: number }[]>(
      "SELECT regime, count(DISTINCT trade_date)::int AS days FROM review_calendar_days WHERE trade_date >= $1 AND trade_date <= $2 AND regime IS NOT NULL GROUP BY regime",
      mn, mx
    );
    const regimeDays: Record<string, number> = {};
    for (const r of regimeDaysRows) if (r.regime) regimeDays[r.regime] = r.days;

    const raw = await prisma.$queryRawUnsafe<Array<{
      rule_id: string; sub_label: string; regime: string | null;
      n5: number; pos5: number; neg5: number;
      n10: number; pos10: number; neg10: number;
    }>>(
      `SELECT a.rule_id, a.sub_label, r.regime,
              count(a.t5_return)::int AS n5,
              count(*) FILTER (WHERE a.t5_return > 0)::int AS pos5,
              count(*) FILTER (WHERE a.t5_return < 0)::int AS neg5,
              count(a.t10_return)::int AS n10,
              count(*) FILTER (WHERE a.t10_return > 0)::int AS pos10,
              count(*) FILTER (WHERE a.t10_return < 0)::int AS neg10
       FROM alert_rule_triggers a
       JOIN review_calendar_days r ON r.trade_date = a.bar_date
       WHERE r.regime IS NOT NULL AND a.bar_date >= $1
       GROUP BY a.rule_id, a.sub_label, r.regime`,
      since
    );

    const agg = new Map<string, Map<string, { n5: number; hit5: number; n10: number; hit10: number }>>();
    for (const r of raw) {
      if (!r.regime || !isActiveSignal(r.rule_id, r.sub_label)) continue;
      const sell = SELL_RULE_IDS.has(r.rule_id);
      let byRegime = agg.get(r.rule_id);
      if (!byRegime) { byRegime = new Map(); agg.set(r.rule_id, byRegime); }
      let a = byRegime.get(r.regime);
      if (!a) { a = { n5: 0, hit5: 0, n10: 0, hit10: 0 }; byRegime.set(r.regime, a); }
      a.n5 += r.n5; a.hit5 += sell ? r.neg5 : r.pos5;
      a.n10 += r.n10; a.hit10 += sell ? r.neg10 : r.pos10;
    }

    const rows: Array<{ ruleId: string; regime: string; n5: number; dirHit5: number | null; n10: number; dirHit10: number | null }> = [];
    for (const [ruleId, byRegime] of agg.entries()) {
      for (const [regime, a] of byRegime.entries()) {
        rows.push({
          ruleId,
          regime,
          n5: a.n5,
          dirHit5: a.n5 > 0 ? Math.round((a.hit5 / a.n5) * 1000) / 10 : null,
          n10: a.n10,
          dirHit10: a.n10 > 0 ? Math.round((a.hit10 / a.n10) * 1000) / 10 : null,
        });
      }
    }

    return NextResponse.json({ window: { min: mn, max: mx }, regimeDays, rows });
  } catch (e: any) {
    console.error('[api/alerts/triggers/regime]', e);
    return NextResponse.json({ error: e.message || '统计失败' }, { status: 500 });
  }
}
