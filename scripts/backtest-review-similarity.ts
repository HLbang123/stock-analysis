/**
 * C3 验证：相似日 kNN 是否有前瞻信息量（Phase 决策用，非产品功能）
 * 思路：对每个历史日 t，只用 t 之前的日期做 kNN（防未来函数），
 * 用近邻的其后 1/5/20 日上证收益均值预测 t 的方向，对比随机基线。
 * 结论判据：命中率显著高于基线（>2~3pct）才值得做相似日 UI，否则不做预测式相似日。
 * 用法：npx tsx scripts/backtest-review-similarity.ts [--k 20]
 */

import { prisma } from "../lib/db";

interface Day {
  trade_date: string;
  volume_ratio: number | null;
  advance: number; decline: number;
  limit_up: number; limit_down: number;
  idx_pct_chg: number | null;
}

const HORIZONS = [1, 5, 20];

function mean(a: number[]) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function std(a: number[]) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(mean(a.map((x) => (x - m) * (x - m))));
}
function pearson(x: number[], y: number[]) {
  const n = Math.min(x.length, y.length);
  if (n < 3) return null;
  const mx = mean(x.slice(0, n)), my = mean(y.slice(0, n));
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) * (x[i] - mx);
    syy += (y[i] - my) * (y[i] - my);
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

async function main() {
  const K = (() => { const i = process.argv.indexOf("--k"); return i >= 0 && process.argv[i + 1] ? parseInt(process.argv[i + 1], 10) : 20; })();
  const days = await prisma.$queryRawUnsafe<Day[]>("SELECT trade_date, volume_ratio, advance, decline, limit_up, limit_down, idx_pct_chg FROM review_calendar_days ORDER BY trade_date");
  const closes = await prisma.$queryRawUnsafe<{ trade_date: string; close: number | null }[]>("SELECT trade_date, close FROM index_daily WHERE ts_code = '000001.SH' ORDER BY trade_date");
  const valid = closes.filter((c) => c.close != null);
  const dates = valid.map((c) => c.trade_date);
  const closeIdx = new Map(dates.map((d, i) => [d, i]));
  const close = new Map(valid.map((c) => [c.trade_date, Number(c.close)]));

  // 构造特征 + 前视收益（只用完整特征的天）
  const rows: { i: number; feats: number[]; fwd: number[] }[] = [];
  for (const d of days) {
    if (d.volume_ratio == null || d.idx_pct_chg == null) continue;
    const up = d.advance + d.decline;
    if (up <= 0) continue;
    const i = closeIdx.get(d.trade_date);
    if (i == null) continue;
    const upRatio = d.advance / up;
    const limitNet = (d.limit_up - d.limit_down) / up;
    const feats = [d.volume_ratio, upRatio, d.idx_pct_chg, limitNet];
    const fwd: number[] = [];
    for (const h of HORIZONS) {
      if (i + h >= dates.length) { fwd.push(NaN); continue; }
      const c0 = close.get(dates[i]); const c1 = close.get(dates[i + h]);
      fwd.push(c0 && c1 ? c1 / c0 - 1 : NaN);
    }
    rows.push({ i, feats, fwd });
  }
  console.log("[C3] 有效样本 " + rows.length + " 天，K=" + K);

  // z-score（全样本）
  const F = 4;
  const means: number[] = [], stds: number[] = [];
  for (let f = 0; f < F; f++) {
    const vals = rows.map((r) => r.feats[f]);
    const m = mean(vals), s = std(vals);
    means.push(m); stds.push(s || 1);
  }
  const z = rows.map((r) => r.feats.map((v, f) => (v - means[f]) / stds[f]));

  // 基线：各期限的上涨占比
  console.log("\n=== 基线（所有日） ===");
  for (let h = 0; h < HORIZONS.length; h++) {
    const arr = rows.map((r) => r.fwd[h]).filter((x) => Number.isFinite(x));
    console.log("  其后 " + HORIZONS[h] + " 日：上涨占比 " + (arr.filter((x) => x > 0).length / arr.length * 100).toFixed(1) + "%（n=" + arr.length + "）");
  }

  // kNN 评估
  for (const h of HORIZONS) {
    const hi = HORIZONS.indexOf(h);
    const pred: number[] = [];
    const actual: number[] = [];
    const startAt = Math.max(K, 60); // 前 60 天只做邻居池，不评估
    for (let t = startAt; t < rows.length; t++) {
      if (!Number.isFinite(rows[t].fwd[hi])) continue;
      const ds: { j: number; d: number }[] = [];
      for (let j = 0; j < t; j++) {
        if (!Number.isFinite(rows[j].fwd[hi])) continue;
        let d2 = 0;
        for (let f = 0; f < F; f++) { const df = z[t][f] - z[j][f]; d2 += df * df; }
        ds.push({ j, d: d2 });
      }
      ds.sort((a, b) => a.d - b.d);
      const kn = ds.slice(0, K).map((x) => rows[x.j].fwd[hi]);
      const p = mean(kn);
      pred.push(p);
      actual.push(rows[t].fwd[hi]);
    }
    const n = pred.length;
    const hit = pred.filter((p, i) => (p > 0) === (actual[i] > 0)).length / n * 100;
    const corr = pearson(pred, actual);
    // 分位：预测值最高 20% vs 最低 20% 的实际均值
    const order = pred.map((_, i) => i).sort((a, b) => pred[a] - pred[b]);
    const topN = Math.max(1, Math.floor(n * 0.2));
    const top = order.slice(n - topN).map((i) => actual[i]);
    const bot = order.slice(0, topN).map((i) => actual[i]);
    const topMean = mean(top), botMean = mean(bot);
    console.log("\n=== 其后 " + h + " 日，kNN 预测 ===");
    console.log("  n=" + n + " 方向命中率=" + hit.toFixed(1) + "%（基线见上） 相关系数=" + (corr == null ? "--" : corr.toFixed(3)));
    console.log("  预测最高20%日 实际均值=" + (topMean * 100).toFixed(2) + "% vs 最低20%日 实际均值=" + (botMean * 100).toFixed(2) + "%（差值 " + ((topMean - botMean) * 100).toFixed(2) + "pct）");
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[C3] 失败:", e.message);
  await prisma.$disconnect();
  process.exit(1);
});
