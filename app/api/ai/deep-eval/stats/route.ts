import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

/**
 * 深度分析全局回测胜率统计（胜率复盘面板数据源）
 *
 * 主口径：买入看涨(returnPct>0=赢)、卖出看跌(returnPct<0=赢)、持有看震荡(|returnPct|<5=赢)。
 * 辅助口径（买入）：目标/止损命中——N 日内最高价是否触及 targetHigh、最低价是否触及 stopLoss，
 *  用 eval.maxRunupPct/maxDrawdownPct 相对 entryPrice 反算，验证深度分析定价能力。
 * 校准口径：置信度/仓位分桶 × T+5 胜率。
 */

function isWin(action: string, returnPct: number): boolean {
  if (action === '买入') return returnPct > 0;
  if (action === '卖出') return returnPct < 0;
  return Math.abs(returnPct) < 5;
}

interface ByNAcc {
  count: number; wins: number; sumReturn: number; sumDd: number; sumRu: number;
  winCnt: number; sumWin: number; lossCnt: number; sumLoss: number;
  targetCount: number; targetHit: number; stopCount: number; stopHit: number;
  bothCount: number; targetOnly: number; stopOnly: number;
}
const emptyAcc = (): ByNAcc => ({ count: 0, wins: 0, sumReturn: 0, sumDd: 0, sumRu: 0, winCnt: 0, sumWin: 0, lossCnt: 0, sumLoss: 0, targetCount: 0, targetHit: 0, stopCount: 0, stopHit: 0, bothCount: 0, targetOnly: 0, stopOnly: 0 });

export async function GET(_request: NextRequest) {
  try {
    const records = await prisma.deepAnalysisRecord.findMany({ include: { evals: true } });

    // ① 建议方向 × nDays 聚合（含买入目标/止损命中）
    const byActionMap = new Map<string, Map<number, ByNAcc>>();
    for (const r of records) {
      for (const e of r.evals) {
        if (e.returnPct == null) continue;
        const n = e.nDays;
        let actionMap = byActionMap.get(r.action);
        if (!actionMap) { actionMap = new Map(); byActionMap.set(r.action, actionMap); }
        const acc = actionMap.get(n) ?? emptyAcc();

        acc.count++;
        if (isWin(r.action, e.returnPct)) acc.wins++;
        acc.sumReturn += e.returnPct;
        // 盈亏比素材：按收益符号分桶（仅买入方向在 UI 展示）
        if (e.returnPct > 0) { acc.winCnt++; acc.sumWin += e.returnPct; }
        else { acc.lossCnt++; acc.sumLoss += e.returnPct; }
        if (e.maxDrawdownPct != null) acc.sumDd += e.maxDrawdownPct;
        if (e.maxRunupPct != null) acc.sumRu += e.maxRunupPct;

        // 买入：验证目标/止损命中（相对 entryPrice 反算最高/最低价）
        if (r.action === '买入' && r.entryPrice > 0) {
          const hasTarget = r.targetHigh != null && r.targetHigh > 0;
          const hasStop = r.stopLoss != null && r.stopLoss > 0;
          let targetHit = false;
          let stopHit = false;
          if (hasTarget && e.maxRunupPct != null) {
            targetHit = r.entryPrice * (1 + e.maxRunupPct / 100) >= r.targetHigh!;
            acc.targetCount++;
            if (targetHit) acc.targetHit++;
          }
          if (hasStop && e.maxDrawdownPct != null) {
            stopHit = r.entryPrice * (1 + e.maxDrawdownPct / 100) <= r.stopLoss!;
            acc.stopCount++;
            if (stopHit) acc.stopHit++;
          }
          if (hasTarget && hasStop && e.maxRunupPct != null && e.maxDrawdownPct != null) {
            acc.bothCount++;
            if (targetHit && !stopHit) acc.targetOnly++;
            if (stopHit && !targetHit) acc.stopOnly++;
          }
        }
        actionMap.set(n, acc);
      }
    }

    const rate = (hit: number, cnt: number) => (cnt > 0 ? Math.round((hit / cnt) * 1000) / 10 : null);

    const byAction = Array.from(byActionMap.entries()).map(([action, byN]) => {
      const nArr = Array.from(byN.entries()).map(([nDays, g]) => {
        const avgWin = g.winCnt > 0 ? Math.round((g.sumWin / g.winCnt) * 100) / 100 : null;
        const avgLoss = g.lossCnt > 0 ? Math.round((g.sumLoss / g.lossCnt) * 100) / 100 : null;
        return {
          nDays,
          count: g.count,
          wins: g.wins,
          winRate: rate(g.wins, g.count) ?? 0,
          avgReturn: g.count > 0 ? Math.round((g.sumReturn / g.count) * 100) / 100 : 0,
          avgMaxDrawdown: g.count > 0 ? Math.round((g.sumDd / g.count) * 100) / 100 : null,
          avgMaxRunup: g.count > 0 ? Math.round((g.sumRu / g.count) * 100) / 100 : null,
          // 盈亏比 = 平均盈 / 平均亏绝对值（仅买入方向语义成立，其余方向置 null 不展示）
          payoff: action === '买入' && avgWin != null && avgLoss != null && avgLoss < 0
            ? Math.round((avgWin / Math.abs(avgLoss)) * 100) / 100
            : null,
        };
      }).sort((a, b) => a.nDays - b.nDays);

      let targetStop: TargetStopRow[] | undefined;
      if (action === '买入') {
        targetStop = nArr.map((g) => {
          const raw = byN.get(g.nDays)!;
          return {
            nDays: g.nDays,
            targetHitRate: rate(raw.targetHit, raw.targetCount),
            stopHitRate: rate(raw.stopHit, raw.stopCount),
            targetOnlyRate: rate(raw.targetOnly, raw.bothCount),
            stopOnlyRate: rate(raw.stopOnly, raw.bothCount),
            targetSamples: raw.targetCount,
            stopSamples: raw.stopCount,
          };
        });
      }
      return { action, byN: nArr, targetStop };
    });

    // ② 摘要：T+5 主口径，overall + 按 action
    const t5 = records.flatMap((r) =>
      r.evals.filter((e) => e.nDays === 5 && e.returnPct != null).map((e) => ({ action: r.action, returnPct: e.returnPct! }))
    );
    const sumByAction = new Map<string, { count: number; wins: number; sumReturn: number }>();
    for (const e of t5) {
      const g = sumByAction.get(e.action) ?? { count: 0, wins: 0, sumReturn: 0 };
      g.count++; g.sumReturn += e.returnPct;
      if (isWin(e.action, e.returnPct)) g.wins++;
      sumByAction.set(e.action, g);
    }
    const overall = { count: t5.length, wins: t5.filter((e) => isWin(e.action, e.returnPct)).length, sumReturn: t5.reduce((s, e) => s + e.returnPct, 0) };

    // ③ 置信度 / 仓位 分桶 × T+5 胜率
    const bucketize = (key: 'confidence' | 'position', buckets: { label: string; min: number; max: number | null }[]) => {
      const out = buckets.map((b) => ({ ...b, count: 0, wins: 0, sumReturn: 0 }));
      for (const r of records) {
        const v = r[key];
        if (v == null) continue;
        const e5 = r.evals.find((e) => e.nDays === 5);
        if (!e5 || e5.returnPct == null) continue;
        const b = out.find((bb) => v >= bb.min && (bb.max == null || v < bb.max));
        if (!b) continue;
        b.count++;
        if (isWin(r.action, e5.returnPct)) b.wins++;
        b.sumReturn += e5.returnPct;
      }
      return out.map((b) => ({
        bucket: b.label,
        count: b.count,
        winRate: rate(b.wins, b.count),
        avgReturn: b.count > 0 ? Math.round((b.sumReturn / b.count) * 100) / 100 : null,
      }));
    };
    const confidenceBuckets = bucketize('confidence', [
      { label: '低(≤30)', min: 0, max: 31 },
      { label: '中(31-70)', min: 31, max: 71 },
      { label: '高(≥71)', min: 71, max: null },
    ]);
    const positionBuckets = bucketize('position', [
      { label: '≤20%', min: 0, max: 21 },
      { label: '21-40%', min: 21, max: 41 },
      { label: '≥41%', min: 41, max: null },
    ]);

    // ④ 大盘环境分桶 × T+5（P3；旧数据 marketRegime 为 NULL → unknown 桶）
    const byRegimeMap = new Map<string, Map<string, { count: number; wins: number; sumReturn: number }>>();
    for (const r of records) {
      const e5 = r.evals.find((e) => e.nDays === 5 && e.returnPct != null);
      if (!e5) continue;
      const regime = r.marketRegime ?? 'unknown';
      let m = byRegimeMap.get(regime);
      if (!m) { m = new Map(); byRegimeMap.set(regime, m); }
      const g = m.get(r.action) ?? { count: 0, wins: 0, sumReturn: 0 };
      g.count++;
      g.sumReturn += e5.returnPct!;
      if (isWin(r.action, e5.returnPct!)) g.wins++;
      m.set(r.action, g);
    }
    const byRegime = ['strong', 'neutral', 'weak', 'unknown'].flatMap((regime) => {
      const m = byRegimeMap.get(regime);
      if (!m) return [];
      return Array.from(m.entries()).map(([action, g]) => ({
        regime,
        action,
        count: g.count,
        winRate: rate(g.wins, g.count),
        avgReturn: g.count > 0 ? Math.round((g.sumReturn / g.count) * 100) / 100 : null,
      }));
    });

    // ⑥ 月度趋势：按 entryDate 月份聚合 T+5（验证 P2 校准注入是否逐步起效）
    const monthMap = new Map<string, { count: number; wins: number; sumReturn: number }>();
    for (const r of records) {
      const e5 = r.evals.find((e) => e.nDays === 5 && e.returnPct != null);
      if (!e5) continue;
      const m = r.entryDate.slice(0, 6);
      const g = monthMap.get(m) ?? { count: 0, wins: 0, sumReturn: 0 };
      g.count++;
      g.sumReturn += e5.returnPct!;
      if (isWin(r.action, e5.returnPct!)) g.wins++;
      monthMap.set(m, g);
    }
    const byMonth = Array.from(monthMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, g]) => ({
        month,
        count: g.count,
        winRate: rate(g.wins, g.count),
        avgReturn: g.count > 0 ? Math.round((g.sumReturn / g.count) * 100) / 100 : null,
      }));

    // ⑦ 待回填：尚无 T+5 结果的记录数（回测按日补，未满 5 个交易日属正常）
    const pendingEvals = records.filter((r) => !r.evals.some((e) => e.nDays === 5 && e.returnPct != null)).length;

    return NextResponse.json({
      summary: {
        primaryN: 5,
        totalRecords: records.length,
        totalEvals: overall.count,
        pendingEvals,
        overall: {
          count: overall.count,
          winRate: rate(overall.wins, overall.count),
          avgReturn: overall.count > 0 ? Math.round((overall.sumReturn / overall.count) * 100) / 100 : null,
        },
        byAction: Array.from(sumByAction.entries()).map(([action, g]) => ({
          action,
          count: g.count,
          winRate: rate(g.wins, g.count),
          avgReturn: g.count > 0 ? Math.round((g.sumReturn / g.count) * 100) / 100 : null,
        })),
      },
      byAction,
      confidenceBuckets,
      positionBuckets,
      byRegime,
      byMonth,
    });
  } catch (e: any) {
    console.error('[api/ai/deep-eval/stats]', e);
    return NextResponse.json({ error: e.message || '统计失败' }, { status: 500 });
  }
}

interface TargetStopRow {
  nDays: number;
  targetHitRate: number | null;
  stopHitRate: number | null;
  targetOnlyRate: number | null;
  stopOnlyRate: number | null;
  targetSamples: number;
  stopSamples: number;
}
