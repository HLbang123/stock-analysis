import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { isActiveSignal } from '@/services/alertRules';

/**
 * 预警规则健康统计 — SQL 下推聚合版。
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
      n: number; wins5: number; sum5: number | null;
      n10: number; wins10: number; sum10: number | null;
      recent30: number; recent30_wins: number;
    }>>(
      `SELECT rule_id, sub_label,
              COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE t5_return > 0)::int AS wins5,
              SUM(t5_return) AS sum5,
              COUNT(t10_return)::int AS n10,
              COUNT(*) FILTER (WHERE t10_return > 0)::int AS wins10,
              SUM(t10_return) AS sum10,
              COUNT(*) FILTER (WHERE bar_date >= $2)::int AS recent30,
              COUNT(*) FILTER (WHERE bar_date >= $2 AND t5_return > 0)::int AS recent30_wins
       FROM alert_rule_triggers
       WHERE bar_date >= $1
         AND t5_return IS NOT NULL
       GROUP BY rule_id, sub_label`,
      since,
      cut30
    );

    const active = rows.filter((r) => isActiveSignal(r.rule_id, r.sub_label));

    // 子信号级聚合
    const stats = active
      .map((r) => ({
        ruleId: r.rule_id,
        subLabel: r.sub_label,
        count: r.n,
        winRate5: r.n > 0 ? Math.round((r.wins5 / r.n) * 1000) / 10 : null,
        avgReturn5: r.n > 0 && r.sum5 != null ? Math.round((r.sum5 / r.n) * 100) / 100 : null,
        winRate10: r.n10 > 0 ? Math.round((r.wins10 / r.n10) * 1000) / 10 : null,
        recent30Count: r.recent30,
        recent30WinRate: r.recent30 > 0 ? Math.round((r.recent30_wins / r.recent30) * 1000) / 10 : null,
      }))
      .sort((a, b) => b.count - a.count);

    // 规则级聚合（R01/R02 阶梯合并子信号；结果仅几十行，JS 加总即可，等价旧 ruleMap）
    const agg = new Map<string, { n: number; wins5: number; sum5: number; n10: number; wins10: number; sum10: number; recent30: number; recent30Wins: number }>();
    for (const r of active) {
      let a = agg.get(r.rule_id);
      if (!a) { a = { n: 0, wins5: 0, sum5: 0, n10: 0, wins10: 0, sum10: 0, recent30: 0, recent30Wins: 0 }; agg.set(r.rule_id, a); }
      a.n += r.n; a.wins5 += r.wins5; a.sum5 += r.sum5 ?? 0;
      a.n10 += r.n10; a.wins10 += r.wins10; a.sum10 += r.sum10 ?? 0;
      a.recent30 += r.recent30; a.recent30Wins += r.recent30_wins;
    }
    const rules = [...agg.entries()]
      .map(([ruleId, a]) => ({
        ruleId,
        count: a.n,
        winRate5: a.n > 0 ? Math.round((a.wins5 / a.n) * 1000) / 10 : null,
        avgReturn5: a.n > 0 ? Math.round((a.sum5 / a.n) * 100) / 100 : null,
        winRate10: a.n10 > 0 ? Math.round((a.wins10 / a.n10) * 1000) / 10 : null,
        recent30Count: a.recent30,
        recent30WinRate: a.recent30 > 0 ? Math.round((a.recent30Wins / a.recent30) * 1000) / 10 : null,
      }))
      .sort((a, b) => b.count - a.count);

    return NextResponse.json({ stats, rules });
  } catch (e: any) {
    console.error('[api/alerts/triggers/stats]', e);
    return NextResponse.json({ error: e.message || '统计失败' }, { status: 500 });
  }
}
