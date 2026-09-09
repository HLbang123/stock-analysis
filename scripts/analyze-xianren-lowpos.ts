/**
 * 仙人指路 — 低位类因子共线性交叉验证（离线，无 DB）
 *
 * 输入：scripts/backtest-xianren-lowpos-dump.ts 落盘的 JSON。
 * 问题：MACD 象限 / MA60 位置 / 60日线斜率 / 距高点回撤 / 距低点涨幅 这些「低位代理」，
 *   在**控制住 gain60 之后**是否还有独立增量？反过来，gain60 在控制住 MACD 后是否还成立？
 *
 * 方法：
 *   1) 边际效应（不控制）：每个二值因子的 T+1 冲高胜率差。
 *   2) 分层效应（控制 gain60）：在每个 gain60 档内算胜率差，再按逆方差加权合并
 *      （fixed-effects 风险差 meta 分析）→ 得到「控制后仍有增量」的检验量 z。
 *   3) 反向：控制 macdQuad 后，gain60≤-10 是否还有增量。
 *   4) 逐年稳定性：把合并结果按年拆开看方向是否一致。
 *
 * 用法：
 *   npx tsx scripts/analyze-xianren-lowpos.ts --file=/tmp/xr-lowpos.json
 *   npx tsx scripts/analyze-xianren-lowpos.ts --file=... --minstratum=30
 */

import { readFileSync } from 'fs';
import { scoreCandidate } from '../services/short-term-strategies/score';
import type { ShortTermCandidate } from '../services/short-term-strategies/types';

interface Row {
  code: string; date: string; year: string; rT1: number; rT5: number;
  gain60: number | null; pctFrom60Low: number | null; ddFrom60High: number | null;
  ma60SlopePct: number | null; ma60Below: number; maDualBull: number; macdQuad: string;
  difVal: number | null; changePct: number | null; amplitudePct: number | null;
  volRatio: number | null; confVolRatio: number | null; t0Turnover: number | null;
  confTurnover: number | null; upperShadowPct: number | null; shadowRatio: number | null;
  bodyAbsPct: number | null; confPct: number | null; confDayGain: number | null;
  confClosePos: number | null; confOpenGap: number | null; t0NearHigh20: number | null;
  hitCount?: number; maxShadow?: number; sectorVolRatioT?: number | null; circMvYi?: number | null;
}

const round = (n: number, d = 2): number => {
  const p = Math.pow(10, d);
  return Math.round(n * p) / p;
};

function rate(rows: Row[], key: 'rT1' | 'rT5' = 'rT1'): { n: number; win: number } {
  const n = rows.length;
  if (!n) return { n: 0, win: 0 };
  return { n, win: (rows.filter((r) => r[key] > 0).length / n) * 100 };
}

/**
 * 固定效应 + 随机效应（DerSimonian-Laird）合并风险差。
 *
 * 固定效应（FE）假设各层真实效应相同，z 会偏乐观——因为同一天的信号高度相关
 * （横截面聚集），有效样本量小于名义 n。随机效应（RE）用层间异质性 tau² 加宽区间，
 * 更能反映「这个因子在不同 gain60 档里表现是否一致」。**判断以 RE 的 z 与逐年方向一致性为准。**
 */
function poolRiskDiff(strata: { a: { n: number; win: number }; b: { n: number; win: number } }[]) {
  const items: { d: number; v: number }[] = [];
  for (const s of strata) {
    if (s.a.n < 1 || s.b.n < 1) continue;
    const p1 = s.a.win / 100, p0 = s.b.win / 100;
    const v = (p1 * (1 - p1)) / s.a.n + (p0 * (1 - p0)) / s.b.n;
    if (!(v > 0)) continue;
    items.push({ d: (p1 - p0) * 100, v });
  }
  if (!items.length) return { diff: 0, se: 0, z: 0, strata: 0, reDiff: 0, reSe: 0, reZ: 0, tau2: 0 };

  const sw = items.reduce((a, it) => a + 1 / it.v, 0);
  const feDiff = items.reduce((a, it) => a + it.d / it.v, 0) / sw;
  const feSe = Math.sqrt(1 / sw);

  // DerSimonian-Laird tau²
  const Q = items.reduce((a, it) => a + (it.d - feDiff) ** 2 / it.v, 0);
  const df = items.length - 1;
  const sw2 = items.reduce((a, it) => a + 1 / (it.v * it.v), 0);
  const C = sw - sw2 / sw;
  const tau2 = df > 0 && C > 0 ? Math.max(0, (Q - df) / C) : 0;
  const swr = items.reduce((a, it) => a + 1 / (it.v + tau2), 0);
  const reDiff = items.reduce((a, it) => a + it.d / (it.v + tau2), 0) / swr;
  const reSe = Math.sqrt(1 / swr);

  return {
    diff: feDiff, se: feSe, z: feSe > 0 ? feDiff / feSe : 0, strata: items.length,
    reDiff, reSe, reZ: reSe > 0 ? reDiff / reSe : 0, tau2,
  };
}

interface Bin { name: string; test: (r: Row) => boolean }

const BINS: Bin[] = [
  { name: 'MACD 零轴下方金叉(g1)', test: (r) => r.macdQuad === 'g1' },
  { name: 'MACD DIF<0', test: (r) => (r.difVal ?? 0) < 0 },
  { name: '价在MA60下方', test: (r) => r.ma60Below === 1 },
  { name: '60日线斜率<0', test: (r) => (r.ma60SlopePct ?? 0) < 0 },
  { name: '距60日高点回撤<=-30%', test: (r) => (r.ddFrom60High ?? 0) <= -30 },
  { name: '距60日低点涨幅<10%', test: (r) => (r.pctFrom60Low ?? 999) < 10 },
  { name: '距20日高<-5%(试盘日)', test: (r) => (r.t0NearHigh20 ?? 0) < -5 },
  { name: '均线多头&价>MA5', test: (r) => r.maDualBull === 1 },
];

const GAIN60_EDGES = [-10, 0, 10, 20];

function gain60Bucket(v: number | null): string {
  if (v == null) return 'N/A';
  if (v <= -10) return 'gain60<=-10';
  if (v < 0) return 'gain60 -10~0';
  if (v < 10) return 'gain60 0~10';
  if (v < 20) return 'gain60 10~20';
  return 'gain60 20~30';
}
const GAIN60_ORDER = ['gain60<=-10', 'gain60 -10~0', 'gain60 0~10', 'gain60 10~20', 'gain60 20~30', 'N/A'];

function main(): void {
  const args = process.argv.slice(2);
  const fileArg = args.find((a) => a.startsWith('--file='));
  const file = fileArg ? fileArg.slice('--file='.length) : '/tmp/xr-lowpos.json';
  const minArg = args.find((a) => a.startsWith('--minstratum='));
  const minStratum = minArg ? Number(minArg.slice('--minstratum='.length)) : 20;

  const data = JSON.parse(readFileSync(file, 'utf8')) as { rows: Row[]; years: string[] };
  const rows = data.rows;
  const base = rate(rows);
  const base5 = rate(rows, 'rT5');
  console.log(`\n总样本 n=${rows.length}  基线 T+1冲高 ${round(base.win)}%  T+5累计 ${round(base5.win)}%`);
  console.log(`年份：${[...new Set(rows.map((r) => r.year))].sort().join(', ')}`);

  // ---------- 1) 边际效应 ----------
  console.log('\n================ 一、边际效应（不控制任何变量）================');
  console.log('因子'.padEnd(28) + '命中n'.padStart(7) + '命中胜率'.padStart(9) + '未命中n'.padStart(8) + '未命中胜率'.padStart(10) + '差值pp'.padStart(8));
  const marginal: Record<string, number> = {};
  for (const bin of BINS) {
    const a = rate(rows.filter(bin.test));
    const b = rate(rows.filter((r) => !bin.test(r)));
    marginal[bin.name] = a.win - b.win;
    console.log(
      bin.name.padEnd(26) + String(a.n).padStart(7) + String(round(a.win)).padStart(9) +
      String(b.n).padStart(8) + String(round(b.win)).padStart(10) + String(round(a.win - b.win)).padStart(8)
    );
  }

  // ---------- 2) 控制 gain60 后的增量 ----------
  console.log('\n================ 二、控制 gain60 后的增量（分层 + 逆方差合并）================');
  for (const bin of BINS) {
    console.log(`\n--- ${bin.name} ---`);
    const strata: { a: { n: number; win: number }; b: { n: number; win: number } }[] = [];
    for (const g of GAIN60_ORDER) {
      if (g === 'N/A') continue;
      const sub = rows.filter((r) => gain60Bucket(r.gain60) === g);
      const a = rate(sub.filter(bin.test));
      const b = rate(sub.filter((r) => !bin.test(r)));
      if (a.n < minStratum || b.n < minStratum) {
        console.log(`  ${g.padEnd(14)} 命中 ${String(a.n).padStart(4)}/${round(a.win)}%  未命中 ${String(b.n).padStart(4)}/${round(b.win)}%  （样本不足，跳过合并）`);
        continue;
      }
      strata.push({ a, b });
      console.log(`  ${g.padEnd(14)} 命中 ${String(a.n).padStart(4)}/${round(a.win)}%  未命中 ${String(b.n).padStart(4)}/${round(b.win)}%  差 ${String(round(a.win - b.win)).padStart(6)}pp`);
    }
    const pooled = poolRiskDiff(strata);
    console.log(`  → 控制 gain60 后：FE ${round(pooled.diff)}pp (z ${round(pooled.z)})  |  RE ${round(pooled.reDiff)}pp (se ${round(pooled.reSe)}, z ${round(pooled.reZ)}, tau² ${round(pooled.tau2, 3)})  | 层数 ${pooled.strata}   边际 ${round(marginal[bin.name])}pp`);

    // 逐年方向一致性（用全年数据，不控制 gain60，看方向是否稳定）
    const years = [...new Set(rows.map((r) => r.year))].sort();
    const perYear = years.map((y) => {
      const sub = rows.filter((r) => r.year === y);
      const a = rate(sub.filter(bin.test));
      const b = rate(sub.filter((r) => !bin.test(r)));
      return `${y.slice(2)}:${round(a.win - b.win)}`;
    }).join(' ');
    console.log(`     逐年差值：${perYear}`);
  }

  // ---------- 3) 反向：控制 MACD 后 gain60 是否还有增量 ----------
  console.log('\n================ 三、反向检验：控制 MACD 象限后，gain60<=-10 还有增量吗 ================');
  const quads = ['g0', 'd0', 'g1', 'd1'];
  const qName: Record<string, string> = { g0: 'DIF>0&金叉', d0: 'DIF>0&死叉', g1: 'DIF<0&金叉', d1: 'DIF<0&死叉' };
  const strata3: { a: { n: number; win: number }; b: { n: number; win: number } }[] = [];
  for (const q of quads) {
    const sub = rows.filter((r) => r.macdQuad === q);
    const a = rate(sub.filter((r) => (r.gain60 ?? 999) <= -10));
    const b = rate(sub.filter((r) => (r.gain60 ?? 999) > -10));
    if (a.n < minStratum || b.n < minStratum) {
      console.log(`  ${qName[q].padEnd(12)} gain60<=-10 ${String(a.n).padStart(4)}/${round(a.win)}%  vs 其他 ${String(b.n).padStart(4)}/${round(b.win)}%  （样本不足）`);
      continue;
    }
    strata3.push({ a, b });
    console.log(`  ${qName[q].padEnd(12)} gain60<=-10 ${String(a.n).padStart(4)}/${round(a.win)}%  vs 其他 ${String(b.n).padStart(4)}/${round(b.win)}%  差 ${String(round(a.win - b.win)).padStart(6)}pp`);
  }
  const pooled3 = poolRiskDiff(strata3);
  console.log(`  → 控制 MACD 后 gain60<=-10 合并差值 ${round(pooled3.diff)}pp（se ${round(pooled3.se)}，z ${round(pooled3.z)}，层数 ${pooled3.strata}）`);

  // ---------- 4) 最强组合（探边界，不做结论） ----------
  console.log('\n================ 四、组合探边界（仅看样本量与胜率，注意多重比较）================');
  const combos: { name: string; test: (r: Row) => boolean }[] = [
    { name: 'g1 & gain60<=-10', test: (r) => r.macdQuad === 'g1' && (r.gain60 ?? 999) <= -10 },
    { name: 'g1 & 价在MA60下', test: (r) => r.macdQuad === 'g1' && r.ma60Below === 1 },
    { name: 'g1 & 回撤<=-30%', test: (r) => r.macdQuad === 'g1' && (r.ddFrom60High ?? 0) <= -30 },
    { name: 'g1 & 斜率<0', test: (r) => r.macdQuad === 'g1' && (r.ma60SlopePct ?? 0) < 0 },
    { name: 'g1 & 距20日高<-5%', test: (r) => r.macdQuad === 'g1' && (r.t0NearHigh20 ?? 0) < -5 },
    { name: 'g1 & 距低点<10%', test: (r) => r.macdQuad === 'g1' && (r.pctFrom60Low ?? 999) < 10 },
  ];
  for (const c of combos) {
    const a = rate(rows.filter(c.test));
    const a5 = rate(rows.filter(c.test), 'rT5');
    console.log(`  ${c.name.padEnd(22)} n=${String(a.n).padStart(4)}  T+1 ${String(round(a.win)).padStart(6)}%   T+5 ${String(round(a5.win)).padStart(6)}%`);
  }

  // ---------- 5) 两个存活因子互相控制（是否同一件事） ----------
  console.log('\n================ 五、存活因子互相控制（g1 vs 回撤<=-30%）================');
  const A = { name: 'MACD零轴下方金叉(g1)', test: (r: Row) => r.macdQuad === 'g1' };
  const Bf = { name: '距60日高点回撤<=-30%', test: (r: Row) => (r.ddFrom60High ?? 0) <= -30 };
  const C = { name: '试盘日距20日高<-5%', test: (r: Row) => (r.t0NearHigh20 ?? 0) < -5 };

  /** 在 given 条件成立、且控制 gain60 分层后，target 的效应 */
  function conditional(target: Bin, given: Bin, label: string): void {
    const strata: { a: { n: number; win: number }; b: { n: number; win: number } }[] = [];
    for (const g of GAIN60_ORDER) {
      if (g === 'N/A') continue;
      const sub = rows.filter((r) => gain60Bucket(r.gain60) === g && given.test(r));
      const a = rate(sub.filter(target.test));
      const b = rate(sub.filter((r) => !target.test(r)));
      if (a.n < 10 || b.n < 10) continue;
      strata.push({ a, b });
    }
    const p = poolRiskDiff(strata);
    console.log(`  ${label.padEnd(38)} RE ${String(round(p.reDiff)).padStart(6)}pp (z ${String(round(p.reZ)).padStart(6)}, 层 ${p.strata})   FE ${String(round(p.diff)).padStart(6)}pp`);
  }

  conditional(A, Bf, '在「回撤<=-30%」内看 g1');
  conditional(A, { name: 'notB', test: (r) => !Bf.test(r) }, '在「回撤>-30%」内看 g1');
  conditional(Bf, A, '在「g1」内看 回撤<=-30%');
  conditional(Bf, { name: 'notA', test: (r) => !A.test(r) }, '在「非g1」内看 回撤<=-30%');
  conditional(C, { name: 'all', test: () => true }, '全样本内看 距20日高<-5%');
  conditional(C, A, '在「g1」内看 距20日高<-5%');

  // 2×2 边际表（不控制 gain60），看两个因子是否重叠
  console.log('\n  g1 × 回撤 2×2（n / T+1胜率）：');
  for (const a of [1, 0]) {
    for (const b of [1, 0]) {
      const sub = rows.filter((r) => (A.test(r) ? 1 : 0) === a && (Bf.test(r) ? 1 : 0) === b);
      const s = rate(sub);
      console.log(`    g1=${a} 回撤<=-30%=${b}  n=${String(s.n).padStart(4)}  T+1 ${String(round(s.win)).padStart(6)}%`);
    }
  }

  // ---------- 6) g1 同时控制「现有打分已用的两个位置/涨幅因子」 ----------
  console.log('\n================ 六、g1 同时控制 gain60 与 试盘日涨幅（现有打分已含）================');
  const cpBucket = (v: number | null): string => {
    if (v == null) return 'NA';
    if (v <= 0.5) return 'cp<=0.5';
    if (v <= 1) return 'cp0.5-1';
    if (v <= 2) return 'cp1-2';
    if (v <= 3) return 'cp2-3';
    return 'cp3-5';
  };
  const cpOrder = ['cp<=0.5', 'cp0.5-1', 'cp1-2', 'cp2-3', 'cp3-5', 'NA'];
  for (const target of [A, Bf, C]) {
    const strata: { a: { n: number; win: number }; b: { n: number; win: number } }[] = [];
    const detail: string[] = [];
    for (const g of GAIN60_ORDER) {
      if (g === 'N/A') continue;
      for (const cp of cpOrder) {
        if (cp === 'NA') continue;
        const sub = rows.filter((r) => gain60Bucket(r.gain60) === g && cpBucket(r.changePct) === cp);
        const a = rate(sub.filter(target.test));
        const b = rate(sub.filter((r) => !target.test(r)));
        if (a.n < 15 || b.n < 15) continue;
        strata.push({ a, b });
        detail.push(`${g.replace('gain60 ', '')}/${cp.replace('cp', '')}:${round(a.win - b.win)}`);
      }
    }
    const p = poolRiskDiff(strata);
    console.log(`  ${target.name.padEnd(24)} RE ${String(round(p.reDiff)).padStart(6)}pp (se ${round(p.reSe)}, z ${String(round(p.reZ)).padStart(6)}, tau² ${round(p.tau2, 2)}, 层 ${p.strata})`);
    console.log(`     各层差值：${detail.join('  ')}`);
  }

  // ---------- 7) g1 在板块共振分档里的表现（尤其 hitCount=0 的 74% 主体） ----------
  if (rows[0]?.hitCount !== undefined) {
    console.log('\n================ 七、g1 在各 hitCount 档里的表现 ================');
    const hcOrder = ['0', '1', '2', '3', '4+'];
    const hcLabel = (v: number): string => (v >= 4 ? '4+' : String(v));
    console.log('hitCount'.padEnd(10) + '档内n'.padStart(7) + '档内胜率'.padStart(9) + 'g1n'.padStart(6) + 'g1胜率'.padStart(8) + '非g1n'.padStart(7) + '非g1胜率'.padStart(9) + '差pp'.padStart(8));
    for (const h of hcOrder) {
      const sub = rows.filter((r) => hcLabel(r.hitCount ?? 0) === h);
      if (!sub.length) continue;
      const all = rate(sub);
      const a = rate(sub.filter(A.test));
      const b = rate(sub.filter((r) => !A.test(r)));
      console.log(
        h.padEnd(10) + String(all.n).padStart(7) + String(round(all.win)).padStart(9) +
        String(a.n).padStart(6) + String(round(a.win)).padStart(8) +
        String(b.n).padStart(7) + String(round(b.win)).padStart(9) +
        String(round(a.win - b.win)).padStart(8)
      );
    }

    console.log('\n  hitCount=0 子集内：g1 控制 gain60 + 试盘日涨幅后');
    const zero = rows.filter((r) => (r.hitCount ?? 0) === 0);
    const strata0: { a: { n: number; win: number }; b: { n: number; win: number } }[] = [];
    const det0: string[] = [];
    for (const g of GAIN60_ORDER) {
      if (g === 'N/A') continue;
      for (const cp of cpOrder) {
        if (cp === 'NA') continue;
        const sub = zero.filter((r) => gain60Bucket(r.gain60) === g && cpBucket(r.changePct) === cp);
        const a = rate(sub.filter(A.test));
        const b = rate(sub.filter((r) => !A.test(r)));
        if (a.n < 10 || b.n < 10) continue;
        strata0.push({ a, b });
        det0.push(`${g.replace('gain60 ', '')}/${cp.replace('cp', '')}:${round(a.win - b.win)}`);
      }
    }
    const p0 = poolRiskDiff(strata0);
    const zeroAll = rate(zero);
    const zeroA = rate(zero.filter(A.test));
    const zeroB = rate(zero.filter((r) => !A.test(r)));
    console.log(`  hitCount=0 基线 n=${zeroAll.n} ${round(zeroAll.win)}%  | g1 n=${zeroA.n} ${round(zeroA.win)}%  vs 非g1 n=${zeroB.n} ${round(zeroB.win)}%  边际差 ${round(zeroA.win - zeroB.win)}pp`);
    console.log(`  → 控制两层后 RE ${round(p0.reDiff)}pp (se ${round(p0.reSe)}, z ${round(p0.reZ)}, tau² ${round(p0.tau2, 2)}, 层 ${p0.strata})`);
    console.log(`     各层差值：${det0.join('  ')}`);
  } else {
    console.log('\n（本 dump 无板块共振字段，跳过第七节）');
  }

  // ---------- 8) 端到端：调生产 scoreCandidate，看加 g1 是否改善排序 ----------
  if (rows[0]?.hitCount !== undefined) {
    console.log('\n================ 八、端到端：生产打分 + g1 加分（直接调 scoreCandidate）================');
    const BANDS: [number, number, string][] = [[0, 39, '0-39'], [40, 59, '40-59'], [60, 79, '60-79'], [80, 100, '80-100']];

    // 注意：生产 score.ts 现已内置 g1 加分。为使本模拟与「已落地」与否无关、可反复复现，
    // 这里先把 macdQuad 置为 'na' 拿「不含 g1 的基线分」，再按变体显式加 bonus。
    function scoreOf(r: Row, g1Bonus: number): number {
      const metrics = {
        hitCount: r.hitCount ?? 0,
        maxShadow: r.maxShadow ?? 0,
        sectorVolRatioT: r.sectorVolRatioT ?? null,
        circMvYi: r.circMvYi ?? null,
        changePct: r.changePct ?? null,
        gain60: r.gain60 ?? null,
        macdQuad: 'na',
      };
      const cand = { strategy: 'xian-ren-zhi-lu', metrics } as unknown as ShortTermCandidate;
      const base = scoreCandidate(cand);
      return Math.max(0, Math.min(100, Math.round(base + (r.macdQuad === 'g1' ? g1Bonus : 0))));
    }

    function bandTable(g1Bonus: number): { bands: { label: string; n: number; win: number }[]; top20: { n: number; win: number }; auc: number } {
      const scored = rows.map((r) => ({ r, s: scoreOf(r, g1Bonus) }));
      const bands = BANDS.map(([lo, hi, label]) => {
        const sub = scored.filter((x) => x.s >= lo && x.s <= hi);
        const st = rate(sub.map((x) => x.r));
        return { label, n: st.n, win: round(st.win) };
      });
      // 取分数最高的 20% 作为「入选」
      const sorted = [...scored].sort((a, b) => b.s - a.s);
      const cut = Math.floor(sorted.length * 0.2);
      const top = rate(sorted.slice(0, cut).map((x) => x.r));
      // 简易 AUC（分数 vs 是否盈利），用于看整体排序能力
      let pos = 0, neg = 0;
      for (const x of scored) if (x.r.rT1 > 0) pos++; else neg++;
      const sortedAsc = [...scored].sort((a, b) => a.s - b.s);
      let cumNeg = 0, aucSum = 0;
      for (const x of sortedAsc) {
        if (x.r.rT1 > 0) aucSum += cumNeg; else cumNeg++;
      }
      const auc = pos > 0 && neg > 0 ? aucSum / (pos * neg) : 0;
      return { bands, top20: { n: top.n, win: round(top.win) }, auc: round(auc, 4) };
    }

    const variants: { name: string; bonus: number }[] = [
      { name: '基线(不含g1)', bonus: 0 },
      { name: 'g1 加 8 分', bonus: 8 },
      { name: 'g1 加 12 分', bonus: 12 },
      { name: 'g1 加 20 分', bonus: 20 },
    ];
    for (const v of variants) {
      const t = bandTable(v.bonus);
      const bandStr = t.bands.map((b) => `${b.label}:${b.n}/${b.win}%`).join('  ');
      console.log(`  ${v.name.padEnd(14)} 分档 ${bandStr}`);
      console.log(`  ${''.padEnd(14)} 顶 20% 入选 n=${t.top20.n} 胜率 ${t.top20.win}%   AUC ${t.auc}`);
    }
    console.log('  （AUC 0.5 = 无区分力；顶 20% 胜率 = 实际入选质量）');

    // 仙人在 score.ts 里最后过了一道 10*sqrt 重标定，加分放在「重标定前 / 后」效果不同，
    // 两种放法都验一遍，避免实现位置选错导致效果打折。
    console.log('\n  —— 加分放在 sqrt 重标定「之前」（即 score.ts 内部累加处）——');
    function scoreOfPreRescale(r: Row, g1Bonus: number): number {
      const metrics = {
        hitCount: r.hitCount ?? 0, maxShadow: r.maxShadow ?? 0,
        sectorVolRatioT: r.sectorVolRatioT ?? null, circMvYi: r.circMvYi ?? null,
        changePct: r.changePct ?? null, gain60: r.gain60 ?? null,
        macdQuad: 'na',
      };
      const cand = { strategy: 'xian-ren-zhi-lu', metrics } as unknown as ShortTermCandidate;
      const post = scoreCandidate(cand);           // 已含 sqrt
      const raw = Math.pow(post / 10, 2);          // 反解出重标定前的原始分
      const raw2 = Math.min(100, raw + (r.macdQuad === 'g1' ? g1Bonus : 0));
      return Math.max(0, Math.min(100, Math.round(10 * Math.sqrt(raw2))));
    }
    for (const v of variants) {
      const scored = rows.map((r) => ({ r, s: scoreOfPreRescale(r, v.bonus) }));
      const bands = BANDS.map(([lo, hi, label]) => {
        const sub = scored.filter((x) => x.s >= lo && x.s <= hi);
        const st = rate(sub.map((x) => x.r));
        return `${label}:${st.n}/${round(st.win)}%`;
      }).join('  ');
      const sorted = [...scored].sort((a, b) => b.s - a.s);
      const cut = Math.floor(sorted.length * 0.2);
      const top = rate(sorted.slice(0, cut).map((x) => x.r));
      let pos = 0, neg = 0;
      for (const x of scored) if (x.r.rT1 > 0) pos++; else neg++;
      const asc = [...scored].sort((a, b) => a.s - b.s);
      let cumNeg = 0, aucSum = 0;
      for (const x of asc) { if (x.r.rT1 > 0) aucSum += cumNeg; else cumNeg++; }
      const auc = pos > 0 && neg > 0 ? aucSum / (pos * neg) : 0;
      console.log(`  ${v.name.padEnd(14)} 分档 ${bands}`);
      console.log(`  ${''.padEnd(14)} 顶 20% 入选 n=${top.n} 胜率 ${round(top.win)}%   AUC ${round(auc, 4)}`);
    }
  } else {
    console.log('\n（本 dump 无板块共振字段，跳过第八节）');
  }
}

main();
