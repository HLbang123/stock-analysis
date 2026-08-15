/**
 * 参数优化扫描（批1，不落库、不改生产）— 用现有落库/回放数据出三份调参建议报告
 *
 * A. 预警规则系数扫描：回放 500 天×抽样标的，对每个候选阈值统计"若阈值为 X 的触发集"的
 *    T+5/T+10 胜率曲线（巨量见顶量比 / 第二波第一波倍数与比例 / 位置门槛 / 上影门槛）
 * B. AI 筛选 RANK_WEIGHT 扫描：用已落库的 screenScore/llmScore 模拟不同融合权重排序的 T+5 表现；
 *    因子 IC 排序（Spearman + 5 分位单调性）
 * C. 深度分析校准报告：置信度/仓位分桶校准曲线、目标/止损命中率（levels.ts 系数建议）
 *
 * 用法: npx tsx scripts/optimize-params.ts [--days=500] [--stocks=800] [--only=ab|bc|...]
 * 输出: 控制台报告（可重定向到文件）
 */

import { prisma } from '../lib/db';
import { checkAllRules, ALERT_RULES } from '../services/alertRules';
import type { KLineData } from '../types';

const DAYS = parseInt(process.argv.find((a) => a.startsWith('--days='))?.split('=')[1] || '500');
const MAX_STOCKS = parseInt(process.argv.find((a) => a.startsWith('--stocks='))?.split('=')[1] || '800');
const ONLY = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1] || 'abc';

interface Acc { n: number; t5s: number[]; t10s: number[] }
const newAcc = (): Acc => ({ n: 0, t5s: [], t10s: [] });
const winRate = (xs: number[]) => (xs.length ? Math.round((xs.filter((x) => x > 0).length / xs.length) * 1000) / 10 : null);
const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);
const avgVol = (win: KLineData[], period: number) => {
  const s = win.slice(-period);
  if (s.length < period) return 0;
  return s.reduce((a, k) => a + k.volume, 0) / period;
};

function sweepReport(rows: { key: string; a: Acc }[], title: string, baseline: { win5: number; avg5: number } | null) {
  console.log(`\n=== ${title} ===`);
  for (const { key, a } of rows.sort((x, y) => x.key.localeCompare(y.key))) {
    const diff = baseline && baseline.win5 != null && winRate(a.t5s) != null
      ? ` (vs基准 ${winRate(a.t5s)! - baseline.win5 >= 0 ? '+' : ''}${(winRate(a.t5s)! - baseline.win5).toFixed(1)}pp)`
      : '';
    console.log(`  阈值 ${key.padEnd(10)} 样本${String(a.n).padStart(6)}  T+5胜率${String(winRate(a.t5s)).padStart(5)}%  T+5均值${String(mean(a.t5s)).padStart(6)}%${diff}`);
  }
}

// ── A. 预警系数扫描（回放）───────────────────────────────────────
async function scanAlertRules() {
  console.log('\n[optimize] ===== A. 预警规则系数扫描（回放中，约 10 分钟）=====');
  const latest = await prisma.dailyBar.findFirst({ orderBy: { tradeDate: 'desc' }, select: { tradeDate: true } });
  if (!latest) return;
  const active = await prisma.dailyBar.findMany({
    where: { tradeDate: latest.tradeDate },
    select: { tsCode: true },
    distinct: ['tsCode'],
  });
  const step = Math.max(1, Math.ceil(active.length / MAX_STOCKS));
  const sample = active.filter((_, i) => i % step === 0).slice(0, MAX_STOCKS).map((s) => s.tsCode);
  const days = await prisma.dailyBar.findMany({
    where: { tradeDate: { lte: latest.tradeDate } },
    select: { tradeDate: true },
    distinct: ['tradeDate'],
    orderBy: { tradeDate: 'desc' },
  });
  const startDate = days[Math.min(days.length - 1, DAYS)]?.tradeDate ?? '20240101';
  const bars = await prisma.dailyBar.findMany({
    where: { tsCode: { in: sample }, tradeDate: { gte: startDate } },
    select: { tsCode: true, tradeDate: true, open: true, high: true, low: true, close: true, vol: true },
    orderBy: [{ tsCode: 'asc' }, { tradeDate: 'asc' }],
  });
  const byStock = new Map<string, KLineData[]>();
  for (const b of bars) {
    if (b.open == null || b.close == null || b.vol == null) continue;
    let arr = byStock.get(b.tsCode);
    if (!arr) { arr = []; byStock.set(b.tsCode, arr); }
    arr.push({ date: b.tradeDate, open: b.open, high: b.high ?? 0, low: b.low ?? 0, close: b.close, volume: b.vol });
  }
  const enabled = ALERT_RULES.filter((r) => r.isEnabled);

  // 各参数阈值 → 触发集（收盘口径与规则内部一致）
  const peakVolTh = [1.5, 1.8, 2.0, 2.2, 2.5, 3.0].map((t) => ({ key: `量比≥${t}x`, a: newAcc() }));
  const secondRatioTh = [0.8, 0.85, 0.9, 0.95].map((t) => ({ key: `比例≥${t}`, a: newAcc() }));
  const secondWaveTh = [1.3, 1.5, 1.8, 2.0].map((t) => ({ key: `第一波≥${t}x均量`, a: newAcc() }));
  const positionTh = [0.85, 0.88, 0.92, 0.95].map((t) => ({ key: `位置≥${t}`, a: newAcc() }));
  const shadowTh = [2, 2.5, 3, 4].map((t) => ({ key: `上影≥${t}%`, a: newAcc() }));
  let baselineN = 0, baselineWin5 = 0, baselineSum5 = 0;

  let processed = 0;
  for (const [code, arr] of byStock) {
    if (arr.length < 70) continue;
    for (let i = 60; i < arr.length - 10; i++) {
      const win = arr.slice(i - 119, i + 1);
      const today = arr[i];
      const prev1 = arr[i - 1];
      const t5 = (arr[i + 5].close / arr[i].close - 1) * 100;
      const t10 = (arr[i + 10].close / arr[i].close - 1) * 100;
      baselineN++; if (t5 > 0) baselineWin5++; baselineSum5 += t5;

      // 扫描参数（与规则内部一致：quote=null → effVol=今日全日量）
      const avg20 = avgVol(win, 20);
      const avg20Wave = avgVol(win.slice(0, -5), 20);
      const volRatio20 = avg20 > 0 ? today.volume / avg20 : 0;
      const high60 = Math.max(...win.slice(-60).map((k) => k.high));
      const pos = high60 > 0 ? today.close / high60 : 0;
      const chg = prev1.close > 0 ? ((today.close - prev1.close) / prev1.close) * 100 : 0;
      const bearish = today.close < today.open;
      const upperPct = today.close !== 0 ? ((today.high - Math.max(today.open, today.close)) / today.close) * 100 : 0;
      const distOf = (s: number) => Math.abs(chg) < 2 || bearish || upperPct >= s;
      const uptrend = chg > 0 ? true : false; // 简化：扫描关注量能/位置维度，uptrend 门统一用位置
      const atTopOf = (p: number) => pos >= p || uptrend;
      const firstWaveMax = Math.max(...win.slice(0, -5).map((k) => k.volume));
      const secondWaveMax = Math.max(...win.slice(-5, -1).map((k) => k.volume));
      const ratio = firstWaveMax > 0 ? secondWaveMax / firstWaveMax : 0;
      const firstWaveMult = avg20Wave > 0 ? firstWaveMax / avg20Wave : 0;

      // 巨量见顶：位置(atTop 0.92) && 量比≥X && 分布(上影3)
      if (atTopOf(0.92) && distOf(3)) {
        for (const t of peakVolTh) if (volRatio20 >= parseFloat(t.key.match(/[\d.]+/)![0])) { t.a.n++; t.a.t5s.push(t5); t.a.t10s.push(t10); }
      }
      // 位置门槛扫描（量比≥2、上影3 固定）
      if (volRatio20 >= 2 && distOf(3)) {
        for (const t of positionTh) if (atTopOf(parseFloat(t.key.match(/[\d.]+/)![0]))) { t.a.n++; t.a.t5s.push(t5); t.a.t10s.push(t10); }
      }
      // 上影门槛扫描（量比≥2、位置0.92 固定）
      if (volRatio20 >= 2 && atTopOf(0.92)) {
        for (const t of shadowTh) if (distOf(parseFloat(t.key.match(/[\d.]+/)![0]))) { t.a.n++; t.a.t5s.push(t5); t.a.t10s.push(t10); }
      }
      // 第二波：第一波倍数扫描（比例0.9、位置0.92 固定）
      if (secondWaveMax >= firstWaveMax * 0.9 && atTopOf(0.92)) {
        for (const t of secondWaveTh) if (firstWaveMult >= parseFloat(t.key.match(/[\d.]+/)![0])) { t.a.n++; t.a.t5s.push(t5); t.a.t10s.push(t10); }
      }
      // 第二波：比例扫描（第一波≥1.5x、位置0.92 固定）
      if (firstWaveMult >= 1.5 && atTopOf(0.92)) {
        for (const t of secondRatioTh) if (secondWaveMax >= firstWaveMax * parseFloat(t.key.match(/[\d.]+/)![0])) { t.a.n++; t.a.t5s.push(t5); t.a.t10s.push(t10); }
      }
    }
    processed++;
    if (processed % 200 === 0) console.log(`[optimize] A 进度 ${processed}/${byStock.size}`);
  }

  const baseline = { win5: Math.round((baselineWin5 / baselineN) * 1000) / 10, avg5: Math.round((baselineSum5 / baselineN) * 100) / 100 };
  console.log(`\n[optimize] A 回放完成：${baselineN} 标的日，基准 T+5 胜率 ${baseline.win5}% / 均值 ${baseline.avg5}%`);
  sweepReport(peakVolTh, 'A1 巨量见顶 · 量比阈值扫描（位置≥0.92 + 分布确认固定）', baseline);
  sweepReport(positionTh, 'A2 位置门槛扫描（量比≥2 + 上影≥3% 固定）', baseline);
  sweepReport(shadowTh, 'A3 上影门槛扫描（量比≥2 + 位置≥0.92 固定）', baseline);
  sweepReport(secondWaveTh, 'A4 第二波 · 第一波倍数扫描（比例≥0.9 + 位置固定）', baseline);
  sweepReport(secondRatioTh, 'A5 第二波 · 比例阈值扫描（第一波≥1.5x + 位置固定）', baseline);
}

// ── B. AI 筛选 RANK_WEIGHT 扫描 + 因子 IC ──────────────────────────
async function scanAiScreen() {
  console.log('\n[optimize] ===== B. AI 筛选 RANK_WEIGHT + 因子 IC =====');
  const picks = await prisma.aiScreenPick.findMany({
    where: { llmScore: { not: null } },
    include: {
      evals: { select: { nDays: true, returnPct: true } },
      run: { select: { strategyId: true, strategyName: true, barDate: true, pickCount: true } },
    },
    take: 30000,
  });
  const retOf = (p: any, n: number): number | null => p.evals.find((e: any) => e.nDays === n)?.returnPct ?? null;

  // RANK_WEIGHT 扫描：按 run 分组，模拟不同权重的融合排序取 top-N（N 同 llmAB 口径）
  const byRun = new Map<string, any[]>();
  for (const p of picks) {
    if (!byRun.has(p.runId)) byRun.set(p.runId, []);
    byRun.get(p.runId)!.push(p);
  }
  const weights = [0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.6];
  const wAccs = weights.map((w) => ({ key: `w=${w}`, a: newAcc() }));
  for (const [, pool] of byRun) {
    const N = Math.min(10, pool[0]?.run?.pickCount || 10, pool.length);
    const t5 = pool.map((p) => retOf(p, 5));
    for (let wi = 0; wi < weights.length; wi++) {
      const w = weights[wi];
      const top = [...pool]
        .sort((a, b) => (b.screenScore * (1 - w) + (b.llmScore ?? 0) * w) - (a.screenScore * (1 - w) + (a.llmScore ?? 0) * w))
        .slice(0, N);
      for (const p of top) { const r = retOf(p, 5); if (r != null) { wAccs[wi].a.n++; wAccs[wi].a.t5s.push(r); } }
    }
    void t5;
  }
  sweepReport(wAccs, 'B1 RANK_WEIGHT 扫描（融合分排序 top-N 的 T+5，当前线上 0.4）', null);

  // 因子 IC（Spearman + 5 分位胜率，全候选）
  const FACTOR_KEYS = ['trend', 'entry_timing', 'risk', 'quality', 'liquidity', 'theme_heat', 'chip', 'box'];
  const rank = (xs: number[]) => {
    const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(xs.length).fill(0);
    let i = 0;
    while (i < idx.length) {
      let j = i;
      while (j < idx.length - 1 && idx[j + 1][0] === idx[i][0]) j++;
      const ar = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k][1]] = ar;
      i = j + 1;
    }
    return r;
  };
  const spearman = (xs: number[], ys: number[]) => {
    const n = xs.length;
    if (n < 10) return null;
    const rx = rank(xs), ry = rank(ys);
    const mx = rx.reduce((a, b) => a + b, 0) / n, my = ry.reduce((a, b) => a + b, 0) / n;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) { const a = rx[i] - mx, b = ry[i] - my; num += a * b; dx += a * a; dy += b * b; }
    if (dx === 0 || dy === 0) return null;
    return num / Math.sqrt(dx * dy);
  };
  console.log('\n=== B2 因子 IC（Spearman，全候选 vs T+5）===');
  const icRows = FACTOR_KEYS.map((f) => {
    const pairs = picks
      .map((p) => ({ f: (p.factorScores as Record<string, number> | null)?.[f], r: retOf(p, 5) }))
      .filter((x): x is { f: number; r: number } => typeof x.f === 'number' && x.r != null);
    const ic = spearman(pairs.map((x) => x.f), pairs.map((x) => x.r));
    const sorted = [...pairs].sort((a, b) => a.f - b.f);
    const per = Math.ceil(sorted.length / 5);
    const q1 = sorted.slice(0, per), q5 = sorted.slice(per * 4);
    const w1 = winRate(q1.map((x) => x.r)), w5 = winRate(q5.map((x) => x.r));
    return { f, n: pairs.length, ic: ic != null ? Math.round(ic * 1000) / 1000 : null, q1w: w1, q5w: w5, mono: w1 != null && w5 != null ? w5 - w1 : null };
  }).sort((a, b) => (b.ic ?? -9) - (a.ic ?? -9));
  for (const r of icRows) {
    console.log(`  ${r.f.padEnd(12)} IC ${String(r.ic).padStart(6)}  样本${String(r.n).padStart(5)}  Q1胜率${String(r.q1w).padStart(5)}%  Q5胜率${String(r.q5w).padStart(5)}%  单调性${r.mono != null ? (r.mono >= 0 ? '+' : '') + r.mono.toFixed(1) : '--'}pp`);
  }
  console.log('  注：单调性 = Q5胜率 - Q1胜率，正值=因子高分更优（有效），负值=因子反向');
}

// ── C. 深度分析校准报告 ───────────────────────────────────────────
async function scanDeepAnalysis() {
  console.log('\n[optimize] ===== C. 深度分析校准报告 =====');
  const records = await prisma.deepAnalysisRecord.findMany({ include: { evals: true } });
  const t5 = records
    .map((r) => ({ action: r.action, confidence: r.confidence, position: r.position, targetHigh: r.targetHigh, stopLoss: r.stopLoss, e: r.evals.find((x) => x.nDays === 5) }))
    .filter((r) => r.e?.returnPct != null);
  const isWin = (a: string, r: number) => (a === '买入' ? r > 0 : a === '卖出' ? r < 0 : Math.abs(r) < 5);

  console.log('\n=== C1 置信度校准（T+5）===');
  const confBuckets = [
    { label: '低(≤30)', min: 0, max: 31 }, { label: '中(31-70)', min: 31, max: 71 }, { label: '高(≥71)', min: 71, max: 999 },
  ];
  for (const b of confBuckets) {
    const rows = t5.filter((r) => r.confidence != null && r.confidence >= b.min && r.confidence < b.max);
    const rets = rows.map((r) => r.e!.returnPct!);
    const wins = rets.filter((r) => r > 0).length;
    console.log(`  ${b.label.padEnd(10)} 样本${String(rets.length).padStart(5)}  胜率${String(rets.length ? Math.round((wins / rets.length) * 1000) / 10 : null).padStart(5)}%  均值${String(mean(rets)).padStart(6)}%`);
  }
  console.log('  注：胜率应随置信度递增；高<低 = 校准失效（AI 过度自信）');

  console.log('\n=== C2 目标/止损命中（买入，T+5 内价格验证）===');
  const buys = records
    .filter((r) => r.action === '买入' && r.entryPrice > 0)
    .map((r) => {
      const e5 = r.evals.find((x) => x.nDays === 5);
      return { entry: r.entryPrice, targetHigh: r.targetHigh, stopLoss: r.stopLoss, e5 };
    })
    .filter((r) => r.e5?.maxRunupPct != null && r.e5?.maxDrawdownPct != null);
  let targetHit = 0, stopHit = 0, targetCnt = 0, stopCnt = 0;
  for (const r of buys) {
    const runup = r.entry * (1 + r.e5!.maxRunupPct! / 100);
    const dd = r.entry * (1 + r.e5!.maxDrawdownPct! / 100);
    if (r.targetHigh != null && r.targetHigh > 0) { targetCnt++; if (runup >= r.targetHigh) targetHit++; }
    if (r.stopLoss != null && r.stopLoss > 0) { stopCnt++; if (dd <= r.stopLoss) stopHit++; }
  }
  console.log(`  目标达成率 ${targetCnt ? Math.round((targetHit / targetCnt) * 1000) / 10 : '--'}%（${targetHit}/${targetCnt}）  止损触及率 ${stopCnt ? Math.round((stopHit / stopCnt) * 1000) / 10 : '--'}%（${stopHit}/${stopCnt}）`);
  console.log('  注：止损触及率显著高于目标达成率 = 止损位偏紧（levels.ts 系数该放宽）；反之目标偏高');

  console.log('\n=== C3 仓位分桶（T+5）===');
  const posBuckets = [
    { label: '≤20%', min: 0, max: 21 }, { label: '21-40%', min: 21, max: 41 }, { label: '≥41%', min: 41, max: 999 },
  ];
  for (const b of posBuckets) {
    const rows = t5.filter((r) => r.position != null && r.position >= b.min && r.position < b.max);
    const rets = rows.map((r) => r.e!.returnPct!);
    console.log(`  ${b.label.padEnd(10)} 样本${String(rets.length).padStart(5)}  胜率${String(rets.length ? Math.round((rets.filter((x) => x > 0).length / rets.length) * 1000) / 10 : null).padStart(5)}%  均值${String(mean(rets)).padStart(6)}%`);
  }
}

async function main() {
  if (ONLY.includes('a')) await scanAlertRules();
  if (ONLY.includes('b')) await scanAiScreen();
  if (ONLY.includes('c')) await scanDeepAnalysis();
  console.log('\n[optimize] ===== 扫描完成 =====');
  await prisma.$disconnect();
}

main().catch((e) => { console.error('[optimize] 失败:', e); process.exit(1); });
