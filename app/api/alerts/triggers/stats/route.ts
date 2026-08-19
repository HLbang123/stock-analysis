import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { DELETED_SUB_LABELS } from '@/services/alertRules';

/**
 * 预警规则健康统计 — 面板卡数据源
 * 按 ruleId+subLabel 聚合触发样本：T+5/T+10 胜率与均值、近 30 天样本（趋势）、触发频率。
 * 只统计有回填结果的样本（t5Return != null）；胜率口径 = T+5 绝对收益 > 0。
 */

export async function GET(request: NextRequest) {
  try {
    const days = parseInt(new URL(request.url).searchParams.get('days') || '180');
    // 近 N 天按「触发日 barDate」过滤（YYYYMMDD 字符串，命中 idx_alert_triggers_bardate 索引）。
    // 原按 createdAt 过滤无索引走全表扫描，且回放历史记录 createdAt 均为回放时刻、会把历史触发误算进近 N 天。
    const since = new Date(Date.now() - days * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(/-/g, '');

    const rows = await prisma.alertRuleTrigger.findMany({
      where: { barDate: { gte: since } },
      select: { ruleId: true, subLabel: true, t5Return: true, t10Return: true, barDate: true },
      take: 100000,
    });

    // 按规则+子信号聚合；"近30天"按触发日(barDate)而非落库时间——回放补的历史样本
    // createdAt 是回放时刻，按它算会把旧样本全计进近30天，趋势列失真
    const map = new Map<string, { ruleId: string; subLabel: string; n: number; t5s: number[]; t10s: number[]; recent30: number; recent30Wins: number }>();
    // 规则级聚合（R01/R02 阶梯含多个子信号，规则级 = 各子信号合并，供「整条规则」判断）
    const ruleMap = new Map<string, { n: number; t5s: number[]; t10s: number[]; recent30: number; recent30Wins: number }>();
    const cut30 = new Date(Date.now() - 30 * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(/-/g, '');
    for (const r of rows) {
      if (DELETED_SUB_LABELS.has(r.subLabel)) continue; // 已删子信号的历史记录，过滤
      const key = `${r.ruleId}:${r.subLabel}`;
      let a = map.get(key);
      if (!a) { a = { ruleId: r.ruleId, subLabel: r.subLabel, n: 0, t5s: [], t10s: [], recent30: 0, recent30Wins: 0 }; map.set(key, a); }
      if (r.t5Return == null) continue;
      a.n++;
      a.t5s.push(r.t5Return);
      if (r.t10Return != null) a.t10s.push(r.t10Return);
      if (r.barDate >= cut30) { a.recent30++; if (r.t5Return > 0) a.recent30Wins++; }
      let ra = ruleMap.get(r.ruleId);
      if (!ra) { ra = { n: 0, t5s: [], t10s: [], recent30: 0, recent30Wins: 0 }; ruleMap.set(r.ruleId, ra); }
      ra.n++;
      ra.t5s.push(r.t5Return);
      if (r.t10Return != null) ra.t10s.push(r.t10Return);
      if (r.barDate >= cut30) { ra.recent30++; if (r.t5Return > 0) ra.recent30Wins++; }
    }

    const stats = [...map.entries()].map(([key, a]) => {
      const win5 = a.t5s.length ? Math.round((a.t5s.filter((x) => x > 0).length / a.t5s.length) * 1000) / 10 : null;
      const avg5 = a.t5s.length ? Math.round((a.t5s.reduce((x, y) => x + y, 0) / a.t5s.length) * 100) / 100 : null;
      const win10 = a.t10s.length ? Math.round((a.t10s.filter((x) => x > 0).length / a.t10s.length) * 1000) / 10 : null;
      return {
        ruleId: a.ruleId,
        subLabel: a.subLabel,
        count: a.n,
        winRate5: win5,
        avgReturn5: avg5,
        winRate10: win10,
        recent30Count: a.recent30,
        recent30WinRate: a.recent30 > 0 ? Math.round((a.recent30Wins / a.recent30) * 1000) / 10 : null,
      };
    }).sort((x, y) => y.count - x.count);

    // 规则级聚合行（R01/R02 阶梯合并子信号；其余单信号规则 = 自身）
    const rules = [...ruleMap.entries()].map(([ruleId, a]) => {
      const win5 = a.t5s.length ? Math.round((a.t5s.filter((x) => x > 0).length / a.t5s.length) * 1000) / 10 : null;
      const avg5 = a.t5s.length ? Math.round((a.t5s.reduce((x, y) => x + y, 0) / a.t5s.length) * 100) / 100 : null;
      const win10 = a.t10s.length ? Math.round((a.t10s.filter((x) => x > 0).length / a.t10s.length) * 1000) / 10 : null;
      return {
        ruleId,
        count: a.n,
        winRate5: win5,
        avgReturn5: avg5,
        winRate10: win10,
        recent30Count: a.recent30,
        recent30WinRate: a.recent30 > 0 ? Math.round((a.recent30Wins / a.recent30) * 1000) / 10 : null,
      };
    }).sort((x, y) => y.count - x.count);

    return NextResponse.json({ stats, rules });
  } catch (e: any) {
    console.error('[api/alerts/triggers/stats]', e);
    return NextResponse.json({ error: e.message || '统计失败' }, { status: 500 });
  }
}
