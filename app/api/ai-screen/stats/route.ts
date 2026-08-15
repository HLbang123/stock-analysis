/**
 * GET /api/ai-screen/stats — AI 筛选胜率复盘
 *
 * 汇总近 N 天(run.createdAt)的 T+N 回测数据,产出:
 *   - summary:整体 + 分策略(胜率/均值/中位/performance_score/outcome),按持有期 T+1/T+5/T+20
 *   - factorIC:每策略每因子 Spearman 秩相关(factor_score vs T+5 returnPct)+ 5 分位胜率
 *   - llmAB:每策略 topK 池内三种选法(纯 screenScore / 0.6·screen+0.4·llm / screen 否决 llmRisks)的 T+5 胜率
 *   - eventSignals:LLM tags/catalysts/risks 当信号,T+5 收益分类 prefer/avoid/watch
 *
 * 主口径 T+5 绝对收益>0。胜率完整性基于全候选(selected+未入选)。
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

const NS = [1, 5, 20];
const PRIMARY_N = 5;
const RANK_WEIGHT = 0.4; // 与 ranker.ts RANK_WEIGHT 一致
const QUANTILES = 5;

interface PickWithEval {
  id: string;
  selected: boolean;
  tsCode: string;
  strategyId: string;
  strategyName: string;
  runId: string;
  barDate: string;
  pickCount: number;
  factorScores: any;
  screenScore: number;
  llmScore: number | null;
  llmConfidence: number | null;
  llmSector: string | null;
  llmTheme: string | null;
  llmTags: string[];
  llmCatalysts: string[];
  llmRisks: string[];
  riskFlags: string[];
  evals: { nDays: number; returnPct: number | null; shapeStatus: string | null }[];
}

/** 平均值 */
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** 收益统计:胜率(>0 占比)、均值、中位 */
function returnStats(returns: number[]) {
  const valid = returns.filter((r) => r != null && Number.isFinite(r));
  if (valid.length === 0) return { count: 0, winRate: null, avg: null, median: null };
  const wins = valid.filter((r) => r > 0).length;
  return {
    count: valid.length,
    winRate: Math.round((wins / valid.length) * 1000) / 10,
    avg: Math.round((mean(valid) ?? 0) * 10000) / 10000,
    median: Math.round((median(valid) ?? 0) * 10000) / 10000,
  };
}

/** Spearman 秩相关系数 */
function spearman(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 5) return null;
  const rx = rank(xs);
  const ry = rank(ys);
  const mx = mean(rx)!;
  const my = mean(ry)!;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = rx[i] - mx, b = ry[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}
function rank(xs: number[]): number[] {
  const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length).fill(0);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j < idx.length - 1 && idx[j + 1][0] === idx[i][0]) j++;
    const avgRank = (i + j) / 2 + 1; // 平均秩(1-based)
    for (let k = i; k <= j; k++) r[idx[k][1]] = avgRank;
    i = j + 1;
  }
  return r;
}

function performanceScore(avg: number | null, win: number | null, missingRate: number): number {
  if (avg == null || win == null) return 0;
  const s = 50 + avg * 2 + (win - 50) * 0.5 - missingRate * 20;
  return Math.max(0, Math.min(100, Math.round(s * 10) / 10));
}
function outcome(avg: number | null, win: number | null): string {
  if (avg == null || win == null) return 'insufficient';
  if (avg >= 2 && win >= 60) return 'strong';
  if (avg > 0 && win >= 50) return 'positive';
  if (avg < 0 && win < 50) return 'negative';
  return 'mixed';
}

export async function GET(request: NextRequest) {
  try {
    const days = parseInt(new URL(request.url).searchParams.get('days') || '60');
    const since = new Date(Date.now() - days * 86400000).toISOString();

    const rows = await prisma.aiScreenPick.findMany({
      where: { run: { createdAt: { gte: since } } },
      include: {
        evals: { select: { nDays: true, returnPct: true, shapeStatus: true } },
        run: { select: { strategyId: true, strategyName: true, barDate: true, pickCount: true } },
      },
      take: 30000,
    });

    const picks: PickWithEval[] = rows.map((r: any) => ({
      id: r.id,
      selected: r.selected,
      tsCode: r.tsCode,
      strategyId: r.run.strategyId,
      strategyName: r.run.strategyName,
      runId: r.runId,
      barDate: r.run.barDate,
      pickCount: r.run.pickCount ?? 10,
      factorScores: r.factorScores ?? {},
      screenScore: r.screenScore,
      llmScore: r.llmScore,
      llmConfidence: r.llmConfidence,
      llmSector: r.llmSector,
      llmTheme: r.llmTheme,
      llmTags: r.llmTags ?? [],
      llmCatalysts: r.llmCatalysts ?? [],
      llmRisks: r.llmRisks ?? [],
      riskFlags: r.riskFlags ?? [],
      evals: r.evals ?? [],
    }));

    // 取某 pick 某 N 的 returnPct
    const retOf = (p: PickWithEval, n: number): number | null => {
      const e = p.evals.find((x) => x.nDays === n);
      return e ? e.returnPct : null;
    };

    // ---- summary:分策略 + 持有期(仅 selected 入选)----
    const byStrategy = new Map<string, PickWithEval[]>();
    for (const p of picks) {
      if (!byStrategy.has(p.strategyId)) byStrategy.set(p.strategyId, []);
      byStrategy.get(p.strategyId)!.push(p);
    }

    const strategies = [...byStrategy.entries()].map(([sid, ps]) => {
      const selected = ps.filter((p) => p.selected);
      const byHoldingPeriod: Record<number, any> = {};
      for (const n of NS) {
        const returns = selected.map((p) => retOf(p, n)).filter((r): r is number => r != null);
        byHoldingPeriod[n] = returnStats(returns);
      }
      const allReturns = selected.map((p) => retOf(p, PRIMARY_N)).filter((r): r is number => r != null);
      const stats = returnStats(allReturns);
      const evaluated = allReturns.length;
      const missingRate = selected.length ? 1 - evaluated / selected.length : 0;
      return {
        strategyId: sid,
        strategyName: ps[0]?.strategyName ?? sid,
        runCount: new Set(ps.map((p) => p.runId)).size,
        candidateCount: ps.length,
        selectedCount: selected.length,
        evaluatedCount: evaluated,
        missingRate: Math.round(missingRate * 1000) / 10,
        avgReturn: stats.avg,
        winRate: stats.winRate,
        performanceScore: performanceScore(stats.avg, stats.winRate, missingRate),
        outcome: outcome(stats.avg, stats.winRate),
        byHoldingPeriod,
      };
    }).sort((a, b) => (b.performanceScore || 0) - (a.performanceScore || 0));

    // ---- factorIC:每策略每因子(T+5,全候选)----
    const FACTOR_KEYS = ['trend', 'entry_timing', 'risk', 'quality', 'liquidity', 'theme_heat', 'chip', 'box'];
    const factorIC = [...byStrategy.entries()].map(([sid, ps]) => {
      const factors = FACTOR_KEYS.map((k) => {
        const pairs = ps
          .map((p) => ({ f: p.factorScores?.[k], r: retOf(p, PRIMARY_N) }))
          .filter((x): x is { f: number; r: number } => x.f != null && x.r != null);
        const ic = spearman(pairs.map((x) => x.f), pairs.map((x) => x.r));
        // 5 分位胜率
        const sorted = [...pairs].sort((a, b) => a.f - b.f);
        const quantiles: { q: number; count: number; winRate: number | null; avg: number | null }[] = [];
        const per = Math.ceil(sorted.length / QUANTILES);
        for (let qi = 0; qi < QUANTILES; qi++) {
          const bucket = sorted.slice(qi * per, qi === QUANTILES - 1 ? sorted.length : (qi + 1) * per);
          const st = returnStats(bucket.map((b) => b.r));
          quantiles.push({ q: qi + 1, count: st.count, winRate: st.winRate, avg: st.avg });
        }
        return { factor: k, ic: ic != null ? Math.round(ic * 10000) / 10000 : null, samples: pairs.length, quantiles };
      });
      return { strategyId: sid, strategyName: ps[0]?.strategyName ?? sid, nDays: PRIMARY_N, factors };
    });

    // ---- llmAB:每策略 topK 池内三种选法(T+5 胜率)----
    const llmAB = [...byStrategy.entries()].map(([sid, ps]) => {
      // 按 run 分组,每 run 取有 llmScore 的 topK 池
      const byRun = new Map<string, PickWithEval[]>();
      for (const p of ps) {
        if (p.llmScore == null) continue;
        if (!byRun.has(p.runId)) byRun.set(p.runId, []);
        byRun.get(p.runId)!.push(p);
      }
      const pure: number[] = [];
      const fusion: number[] = [];
      const veto: number[] = [];
      for (const [, pool] of byRun) {
        const N = Math.min(10, pool[0]?.pickCount || 10, pool.length);
        const byScreen = [...pool].sort((a, b) => b.screenScore - a.screenScore).slice(0, N);
        const byFusion = [...pool]
          .sort((a, b) => (b.screenScore * (1 - RANK_WEIGHT) + (b.llmScore ?? 0) * RANK_WEIGHT) - (a.screenScore * (1 - RANK_WEIGHT) + (a.llmScore ?? 0) * RANK_WEIGHT))
          .slice(0, N);
        const byVeto = [...pool].filter((p) => (p.llmRisks?.length ?? 0) === 0).sort((a, b) => b.screenScore - a.screenScore).slice(0, N);
        for (const p of byScreen) { const r = retOf(p, PRIMARY_N); if (r != null) pure.push(r); }
        for (const p of byFusion) { const r = retOf(p, PRIMARY_N); if (r != null) fusion.push(r); }
        for (const p of byVeto) { const r = retOf(p, PRIMARY_N); if (r != null) veto.push(r); }
      }
      const pureS = returnStats(pure);
      const fusionS = returnStats(fusion);
      const vetoS = returnStats(veto);
      return {
        strategyId: sid,
        strategyName: ps[0]?.strategyName ?? sid,
        pureScreen: pureS,
        fusion: fusionS,
        veto: vetoS,
        // 融合 vs 纯规则 的增量（胜率百分点 + 均值差）：正=LLM 重排加分，负=拖累
        deltaWin: fusionS.winRate != null && pureS.winRate != null
          ? Math.round((fusionS.winRate - pureS.winRate) * 10) / 10 : null,
        deltaAvg: fusionS.avg != null && pureS.avg != null
          ? Math.round((fusionS.avg - pureS.avg) * 10000) / 10000 : null,
      };
    });

    // ---- eventSignals:LLM tags/catalysts/risks 当信号(T+5,全候选)----
    const signalGroups = new Map<string, number[]>();
    const signalType = new Map<string, string>();
    for (const p of picks) {
      const r = retOf(p, PRIMARY_N);
      if (r == null) continue;
      const sigs: [string, string][] = [
        ...p.llmTags.map((t) => [t, 'tag'] as [string, string]),
        ...p.llmCatalysts.map((c) => [c, 'catalyst'] as [string, string]),
        ...p.llmRisks.map((k) => [k, 'risk'] as [string, string]),
      ];
      for (const [s, t] of sigs) {
        const key = `${t}:${s}`;
        if (!signalGroups.has(key)) { signalGroups.set(key, []); signalType.set(key, t); }
        signalGroups.get(key)!.push(r);
      }
    }
    const eventSignals = [...signalGroups.entries()]
      .map(([key, rets]) => {
        const st = returnStats(rets);
        const [t, label] = [signalType.get(key)!, key.slice(key.indexOf(':') + 1)];
        let action = 'watch';
        if (st.avg == null || st.winRate == null || st.count < 5) action = 'insufficient';
        else if (st.avg > 0 && st.winRate >= 50) action = 'prefer';
        else if (st.avg < 0 || st.winRate < 50) action = 'avoid';
        return { signal: label, type: signalType.get(key), count: st.count, avgReturn: st.avg, winRate: st.winRate, action };
      })
      .sort((a, b) => (b.count || 0) - (a.count || 0))
      .slice(0, 40);

    // ---- 整体 summary ----
    const allSelected = picks.filter((p) => p.selected);
    const allReturns = allSelected.map((p) => retOf(p, PRIMARY_N)).filter((r): r is number => r != null);
    const overall = returnStats(allReturns);
    const pendingEvals = allSelected.length - allReturns.length;

    // ---- 月度趋势：入选建议 T+5 按月聚合（验证规则/LLM 调优随时间的演进）----
    const monthMap = new Map<string, number[]>();
    for (const p of allSelected) {
      const r = retOf(p, PRIMARY_N);
      if (r == null) continue;
      const m = p.barDate.slice(0, 6);
      if (!monthMap.has(m)) monthMap.set(m, []);
      monthMap.get(m)!.push(r);
    }
    const byMonth = [...monthMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, rets]) => ({ month, ...returnStats(rets) }));

    return NextResponse.json({
      primaryN: PRIMARY_N,
      summary: { ...overall, runCount: new Set(picks.map((p) => p.runId)).size, candidateCount: picks.length, selectedCount: allSelected.length, pendingEvals },
      strategies,
      factorIC,
      llmAB,
      eventSignals,
      byMonth,
    });
  } catch (e: any) {
    console.error('[api/ai-screen/stats]', e);
    return NextResponse.json({ error: e.message || '统计失败' }, { status: 500 });
  }
}
