/**
 * 仙人指路 — 因子梯度扫描（冲高口径，剔 924，2022~2026 五年）
 *
 * 目的：在「当前生产门槛」的仙人指路信号池上，对 spec 遗留因子 + 新维度做梯度复验，
 *   找出「能明显提升胜率」的筛选维度。用户口径（2026-09-09）：
 *   - 样本已很多，只要能明显提升胜率，样本砍半也可接受。
 *   - 五年窗口，剔除 924。
 *
 * 固定基线 = 当前生产配置 DEFAULT_XIANREN_CONFIG（volRatioMin=0、上影1.5、反包40、
 *   收盘位0.7、高开<=1 等），不再动这些门，只对命中的信号做因子分桶看胜率梯度。
 *
 * 收益口径 = 冲高：T+1 当日最高 + T+5 累计最高（胜率>0、均值），外加 T+5 冲高>2%。
 * 性能：O(1) 前置闸门（上影>=1.5 & 反包>=40 & 收盘位>=0.7 & 高开<=1）过滤后再进 detect。
 *
 * 用法：
 *   npx tsx scripts/backtest-xianren-factor-scan.ts --selftest
 *   npx tsx scripts/backtest-xianren-factor-scan.ts
 */

import { prisma } from '../lib/db';
import { detectXianRenAt, DEFAULT_XIANREN_CONFIG, XianRenBar } from '../lib/strategy/xian-ren-zhi-lu';
import { computeChipDistribution } from '../lib/chip';

interface RawBar {
  tsCode: string;
  tradeDate: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  preClose: number | null;
  vol: number | null;
  turnoverRate: number | null;
  circMv: number | null;
  name: string | null;
}

const YEARS = ['2022', '2023', '2024', '2025', '2026'];
const EXCLUDE_LO = '2024-09-24';
const EXCLUDE_HI = '2024-10-08';

const round = (n: number, d = 2): number => {
  const p = Math.pow(10, d);
  return Math.round(n * p) / p;
};

const fmtDate = (d: string): string =>
  d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d;

interface CellAcc {
  t1: number[];
  t5cum: number[];
}

function stats(arr: number[]): { n: number; avg: number; winRate: number } {
  const n = arr.length;
  const avg = n ? arr.reduce((a, b) => a + b, 0) / n : 0;
  const win = n ? arr.filter((x) => x > 0).length / n : 0;
  return { n, avg: round(avg), winRate: round(win * 100) };
}

function gt2Pct(arr: number[]): number {
  const n = arr.length;
  return n ? round((arr.filter((x) => x > 2).length / n) * 100) : 0;
}

function bucket(v: number, edges: number[], labels: string[]): string {
  for (let i = 0; i < edges.length; i++) if (v < edges[i]) return labels[i];
  return labels[labels.length - 1];
}

interface Metrics {
  confPct: number;
  confDayGain: number;
  gain60: number;
  upperShadowPct: number;
  changePct: number;
  amplitudePct: number;
  bodyAbsPct: number;
  volRatio: number;
  shadowRatio: number;
  confVolRatio: number;
  confTurnover: number | null;
  confOpenGap: number;
  confClosePos: number;
  t0NearHigh20: number;
  confToT0Vol: number;
  circMvYi: number | null;
  peakPos: number | null;
}

interface Factor {
  name: string;
  edges: number[];
  labels: string[];
  get: (m: Metrics) => number | null;
}

const FACTORS: Factor[] = [
  { name: 'confPct', edges: [50, 60, 80, 100], labels: ['40-50', '50-60', '60-80', '80-100', '>=100'], get: (m) => m.confPct },
  { name: 'confDayGain', edges: [1, 2, 3, 5], labels: ['<1', '1-2', '2-3', '3-5', '>=5'], get: (m) => m.confDayGain },
  { name: 'gain60', edges: [-10, 0, 10, 20], labels: ['<=-10', '-10-0', '0-10', '10-20', '20-30'], get: (m) => m.gain60 },
  { name: 'upperShadowPct', edges: [2, 2.5, 3, 4], labels: ['1.5-2', '2-2.5', '2.5-3', '3-4', '>=4'], get: (m) => m.upperShadowPct },
  { name: 'changePct', edges: [0.5, 1, 2, 3], labels: ['0-0.5', '0.5-1', '1-2', '2-3', '3-5'], get: (m) => m.changePct },
  { name: 'amplitudePct', edges: [3, 4], labels: ['<=3', '3-4', '4-5'], get: (m) => m.amplitudePct },
  { name: 'bodyAbsPct', edges: [0.5, 1, 1.5], labels: ['<=0.5', '0.5-1', '1-1.5', '1.5-2'], get: (m) => m.bodyAbsPct },
  { name: 'volRatio', edges: [0.8, 1.2, 2, 3], labels: ['<0.8', '0.8-1.2', '1.2-2', '2-3', '>=3'], get: (m) => m.volRatio },
  { name: 'shadowRatio', edges: [2, 3, 5], labels: ['1.2-2', '2-3', '3-5', '>=5'], get: (m) => m.shadowRatio },
  { name: 'confVolRatio', edges: [0.6, 0.8, 1.0, 1.5], labels: ['<0.6', '0.6-0.8', '0.8-1.0', '1.0-1.5', '>=1.5'], get: (m) => m.confVolRatio },
  { name: 'confTurnover', edges: [3, 5, 10, 15], labels: ['<3', '3-5', '5-10', '10-15', '>=15'], get: (m) => m.confTurnover },
  { name: 'confOpenGap', edges: [0, 0.5], labels: ['<=0', '0-0.5', '0.5-1.0'], get: (m) => m.confOpenGap },
  { name: 'confClosePos', edges: [0.8, 0.9], labels: ['0.7-0.8', '0.8-0.9', '0.9-1.0'], get: (m) => m.confClosePos },
  { name: 't0NearHigh20', edges: [0, 2], labels: ['<0', '0-2', '>=2'], get: (m) => m.t0NearHigh20 },
  { name: 'confToT0Vol', edges: [0.5, 1, 2], labels: ['<0.5', '0.5-1', '1-2', '>=2'], get: (m) => m.confToT0Vol },
  { name: 'circMvYi', edges: [30, 50, 100, 300], labels: ['<30亿', '30-50亿', '50-100亿', '100-300亿', '>=300亿'], get: (m) => m.circMvYi },
  { name: 'peakPos', edges: [0, 0.03, 0.08], labels: ['<0', '0-0.03', '0.03-0.08', '>=0.08'], get: (m) => m.peakPos },
];

function loadBars(start: string, end: string): Promise<RawBar[]> {
  const sql = [
    'SELECT b."tsCode" AS "tsCode", b."tradeDate" AS "tradeDate",',
    '       b.open, b.high, b.low, b.close, b.pre_close AS "preClose", b.vol,',
    '       b.turnover_rate AS "turnoverRate", b.circ_mv AS "circMv"',
    'FROM daily_bars b',
    'JOIN stocks s ON s.ts_code = b."tsCode"',
    'WHERE b."tradeDate" >= $1 AND b."tradeDate" <= $2',
    "  AND s.is_active = true",
    "  AND s.ts_code ~ '^(600|601|603|605|000|001|002|003)'",
    "  AND s.name !~ '(ST|退)'",
  ].join('\n');
  return prisma.$queryRawUnsafe<RawBar[]>(sql, start, end);
}

type Acc = Record<string, Record<string, CellAcc>>;

function emptyAcc(): Acc {
  const out: Acc = {};
  for (const f of FACTORS) {
    out[f.name] = {};
    for (const label of f.labels) out[f.name][label] = { t1: [], t5cum: [] };
  }
  return out;
}

function processRaw(raw: RawBar[], year: string, acc: Acc): void {
  const byCode = new Map<string, RawBar[]>();
  for (const r of raw) {
    if (r.open == null || r.close == null || r.high == null || r.low == null) continue;
    if (!byCode.has(r.tsCode)) byCode.set(r.tsCode, []);
    byCode.get(r.tsCode)!.push(r);
  }

  for (const rawBars of byCode.values()) {
    rawBars.sort((a, b) => (a.tradeDate < b.tradeDate ? -1 : 1));
    const bars: XianRenBar[] = rawBars.map((r) => ({
      date: fmtDate(r.tradeDate),
      open: r.open as number,
      high: r.high as number,
      low: r.low as number,
      close: r.close as number,
      volume: Number(r.vol ?? 0),
      preClose: r.preClose != null ? Number(r.preClose) : null,
      turnoverRate: r.turnoverRate != null ? Number(r.turnoverRate) : null,
    }));

    for (let i = 61; i < bars.length; i++) {
      const t0 = bars[i - 1];
      const t1 = bars[i];

      // O(1) 前置闸门（当前生产门槛的超集）
      const upperShadow = t0.high - Math.max(t0.open, t0.close);
      const upperShadowPct = (upperShadow / t0.open) * 100;
      if (upperShadowPct < 1.5) continue;
      const confPctPct = upperShadow > 0 ? ((t1.close - t0.close) / upperShadow) * 100 : 0;
      if (confPctPct < 40) continue;
      const confClosePos = t1.high > t1.low ? (t1.close - t1.low) / (t1.high - t1.low) : 0.5;
      if (confClosePos < 0.7) continue;
      const confOpenGap = ((t1.open - t0.close) / t0.close) * 100;
      if (confOpenGap > 1.0) continue;

      const sig = detectXianRenAt(bars, i, DEFAULT_XIANREN_CONFIG);
      if (!sig.matched) continue;
      if (sig.entryDate.slice(0, 4) !== year) continue;
      if (sig.entryDate >= EXCLUDE_LO && sig.entryDate <= EXCLUDE_HI) continue;

      const entry = sig.entryPrice;
      if (!entry || entry <= 0) continue;
      const b1 = bars[i + 1];
      if (!b1) continue;
      const retT1 = ((b1.high - entry) / entry) * 100;
      let cumHigh = -Infinity;
      let ok = true;
      for (let n = 1; n <= 5; n++) {
        const b = bars[i + n];
        if (!b) { ok = false; break; }
        if (b.high > cumHigh) cumHigh = b.high;
      }
      if (!ok) continue;
      const retT5Cum = ((cumHigh - entry) / entry) * 100;

      // ---- 计算因子 ----
      const prevClose0 = t0.preClose != null && t0.preClose > 0 ? t0.preClose : bars[i - 2].close;
      const bodyAbs = Math.abs(t0.close - t0.open);
      const bodyAbsPct = (bodyAbs / t0.open) * 100;
      const shadowRatio = bodyAbs > 0.01 ? upperShadow / bodyAbs : (upperShadow > 0 ? 999 : 0);
      const changePct = ((t0.close - prevClose0) / prevClose0) * 100;
      const amplitudePct = ((t0.high - t0.low) / prevClose0) * 100;
      const confDayGain = ((t1.close - t0.close) / t0.close) * 100;
      const gain60 = ((prevClose0 / bars[i - 61].close) - 1) * 100;

      let volSum = 0, volCnt = 0;
      for (let j = i - 6; j < i - 1; j++) { volSum += bars[j].volume; volCnt++; }
      const volRatio = volCnt > 0 ? t0.volume / (volSum / volCnt) : 0;

      let cvs = 0, cvc = 0;
      for (let j = i - 5; j < i; j++) { cvs += bars[j].volume; cvc++; }
      const confVolRatio = cvc > 0 ? t1.volume / (cvs / cvc) : 0;

      let maxHigh20 = -Infinity;
      for (let j = i - 20; j < i - 1; j++) if (bars[j].high > maxHigh20) maxHigh20 = bars[j].high;
      const t0NearHigh20 = maxHigh20 > 0 ? (t0.high / maxHigh20 - 1) * 100 : 0;

      const confToT0Vol = t0.volume > 0 ? t1.volume / t0.volume : 0;
      const circMvYi = rawBars[i].circMv != null ? Number(rawBars[i].circMv) / 10000 : null;

      const chipBars = bars.slice(Math.max(0, i - 89), i).map((b) => ({
        high: b.high, low: b.low, close: b.close, vol: b.volume, turnoverRate: b.turnoverRate ?? null,
      }));
      const chip = computeChipDistribution(chipBars, t1.close);
      const peakPos = chip?.peakPos ?? null;

      const m: Metrics = {
        confPct: confPctPct,
        confDayGain,
        gain60,
        upperShadowPct,
        changePct,
        amplitudePct,
        bodyAbsPct,
        volRatio,
        shadowRatio,
        confVolRatio,
        confTurnover: t1.turnoverRate ?? null,
        confOpenGap,
        confClosePos,
        t0NearHigh20,
        confToT0Vol,
        circMvYi,
        peakPos,
      };

      for (const f of FACTORS) {
        const v = f.get(m);
        if (v == null || !Number.isFinite(v)) continue;
        const label = bucket(v, f.edges, f.labels);
        const cell = acc[f.name][label];
        cell.t1.push(retT1);
        cell.t5cum.push(retT5Cum);
      }
    }
  }
}

function selfTest(): void {
  const m: Metrics = {
    confPct: 55, confDayGain: 2.5, gain60: 5, upperShadowPct: 2.3, changePct: 1.5,
    amplitudePct: 4, bodyAbsPct: 1.2, volRatio: 1.5, shadowRatio: 2.5, confVolRatio: 0.9,
    confTurnover: 4, confOpenGap: 0.5, confClosePos: 0.85, t0NearHigh20: 1.5,
    confToT0Vol: 0.8, circMvYi: 60, peakPos: 0.05,
  };
  console.log('selftest buckets:');
  for (const f of FACTORS) {
    const v = f.get(m);
    if (v == null) continue;
    console.log(' ', f.name, '=', v, '->', bucket(v, f.edges, f.labels));
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) { selfTest(); return; }

  const latestRow = await prisma.dailyBar.findFirst({
    orderBy: { tradeDate: 'desc' },
    select: { tradeDate: true },
  });
  if (!latestRow) throw new Error('no daily bars');
  const latestDate = latestRow.tradeDate;

  const acc = emptyAcc();
  const t0 = Date.now();
  for (const year of YEARS) {
    const loadStart = `${Number(year) - 1}0901`;
    const loadEndRaw = `${Number(year) + 1}0110`;
    const loadEnd = loadEndRaw < latestDate ? loadEndRaw : latestDate;
    const raw = await loadBars(loadStart, loadEnd);
    processRaw(raw, year, acc);
    console.log('year', year, 'window', loadStart, '->', loadEnd, 'loaded', raw.length, 'elapsed', Date.now() - t0, 'ms');
  }

  console.log('\n=== 因子梯度（剔924，2022-2026）===');
  for (const f of FACTORS) {
    const cells = acc[f.name];
    const summary = Object.fromEntries(
      f.labels.map((label) => {
        const c = cells[label];
        return [label, {
          n: c.t1.length,
          t1: stats(c.t1),
          t5cum: stats(c.t5cum),
          t5gt2Pct: gt2Pct(c.t5cum),
        }];
      })
    );
    console.log('\n## ' + f.name);
    console.log(JSON.stringify(summary, null, 2));
  }

  console.log('\ntotal elapsed', Date.now() - t0, 'ms');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
