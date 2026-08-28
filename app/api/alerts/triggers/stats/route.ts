import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { isActiveSignal, SELL_RULE_IDS } from '@/services/alertRules';

/**
 * 预警规则健康统计 — SQL 下推聚合版（方向感知）。
 * 胜率口径：卖出侧(R01/R02/R03/R14)命中 = T+5/T+10 下跌，买入侧命中 = 上涨；均值统一为方向收益。
 * 单条 GROUP BY 直接算好各 (ruleId, subLabel) 的 T+5/T+10 胜率与均值、近30天样本，
 * 只回几十行，替代旧的「findMany 拉最多 10 万行进 JS 聚合」——近180天窗口 11.5 万行
 * 已超 take:100000 静默截断（且无 orderBy，截掉的是任意子集），是 20s 主因 + 统计失真根因。
 * 过滤改 (ruleId, subLabel) 白名单（isActiveSignal），已删/改名/跨规则残留信号自动排除。
 */
export async function GET(request: NextRequest) {
  try {
    const days = parseInt(new URL(request.url).searchParams.get('days') || '180');
    const since = new Date(Date.now() - days * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(/-/g, '');
    const cut30 = new Date(Date.now() - 30 * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(/-/g, '');

    const rows = await prisma.$queryRawUnsafe<Array<{
      rule_id: string; sub_label: string;
      n: number; pos5: number; neg5: number; sum5: number | null;
      n10: number; pos10: number; neg10: number; sum10: number | null;
      recent30: number; recent30_pos: number; recent30_neg: number;
    }>>(
      `SELECT rule_id, sub_label,
              COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE t5_return > 0)::int AS pos5,
              COUNT(*) FILTER (WHERE t5_return < 0)::int AS neg5,
              SUM(t5_return) AS sum5,
              COUNT(t10_return)::int AS n10,
              COUNT(*) FILTER (WHERE t10_return > 0)::int AS pos10,
              COUNT(*) FILTER (WHERE t10_return < 0)::int AS neg10,
              SUM(t10_return) AS sum10,
              COUNT(*) FILTER (WHERE bar_date >= $2)::int AS recent30,
              COUNT(*) FILTER (WHERE bar_date >= $2 AND t5_return > 0)::int AS recent30_pos,
              COUNT(*) FILTER (WHERE bar_date >= $2 AND t5_return < 0)::int AS recent30_neg
       FROM alert_rule_triggers
       WHERE bar_date >= $1
         AND t5_return IS NOT NULL
       GROUP BY rule_id, sub_label`,
      since,
      cut30
    );

    const active = rows.filter((r) => isActiveSignal(r.rule_id, r.sub_label));

    // 子信号级聚合（方向感知：卖出侧命中=下跌，买入侧命中=上涨；均值统一为方向收益）
    const stats = active
      .map((r) => {
        const sell = SELL_RULE_IDS.has(r.rule_id);
        const wins5 = sell ? r.neg5 : r.pos5;
        const wins10 = sell ? r.neg10 : r.pos10;
        const recent30Wins = sell ? r.recent30_neg : r.recent30_pos;
        const avg5 = r.n > 0 && r.sum5 != null ? r.sum5 / r.n : null;
        return {
          ruleId: r.rule_id,
          subLabel: r.sub_label,
          count: r.n,
          winRate5: r.n > 0 ? Math.round((wins5 / r.n) * 1000) / 10 : null,
          avgReturn5: avg5 == null ? null : Math.round((sell ? -avg5 : avg5) * 100) / 100,
          winRate10: r.n10 > 0 ? Math.round((wins10 / r.n10) * 1000) / 10 : null,
          recent30Count: r.recent30,
          recent30WinRate: r.recent30 > 0 ? Math.round((recent30Wins / r.recent30) * 1000) / 10 : null,
        };
      })
      .sort((a, b) => b.count - a.count);

    // 规则级聚合（R01/R02 阶梯合并子信号；结果仅几十行，JS 加总即可，等价旧 ruleMap）
    const agg = new Map<string, { n: number; pos5: number; neg5: number; sum5: number; n10: number; pos10: number; neg10: number; sum10: number; recent30: number; recent30Pos: number; recent30Neg: number }>();
    for (const r of active) {
      let a = agg.get(r.rule_id);
      if (!a) { a = { n: 0, pos5: 0, neg5: 0, sum5: 0, n10: 0, pos10: 0, neg10: 0, sum10: 0, recent30: 0, recent30Pos: 0, recent30Neg: 0 }; agg.set(r.rule_id, a); }
      a.n += r.n; a.pos5 += r.pos5; a.neg5 += r.neg5; a.sum5 += r.sum5 ?? 0;
      a.n10 += r.n10; a.pos10 += r.pos10; a.neg10 += r.neg10; a.sum10 += r.sum10 ?? 0;
      a.recent30 += r.recent30; a.recent30Pos += r.recent30_pos; a.recent30Neg += r.recent30_neg;
    }
    const rules = [...agg.entries()]
      .map(([ruleId, a]) => {
        const sell = SELL_RULE_IDS.has(ruleId);
        const wins5 = sell ? a.neg5 : a.pos5;
        const wins10 = sell ? a.neg10 : a.pos10;
        const recent30Wins = sell ? a.recent30Neg : a.recent30Pos;
        const avg5 = a.n > 0 ? a.sum5 / a.n : null;
        return {
          ruleId,
          count: a.n,
          winRate5: a.n > 0 ? Math.round((wins5 / a.n) * 1000) / 10 : null,
          avgReturn5: avg5 == null ? null : Math.round((sell ? -avg5 : avg5) * 100) / 100,
          winRate10: a.n10 > 0 ? Math.round((wins10 / a.n10) * 1000) / 10 : null,
          recent30Count: a.recent30,
          recent30WinRate: a.recent30 > 0 ? Math.round((recent30Wins / a.recent30) * 1000) / 10 : null,
        };
      })
      .sort((a, b) => b.count - a.count);

    return NextResponse.json({ stats, rules });
  } catch (e: any) {
    console.error('[api/alerts/triggers/stats]', e);
    return NextResponse.json({ error: e.message || '统计失败' }, { status: 500 });
  }
}
