/**
 * 仙人指路 — 「无板块共振」子集因子梯度（主口径 T+1 冲高胜率）
 *
 * 目的：74% 的样本 hitCount=0（无板块共振），当前只能靠 circMv 加分（0~24），
 *   全挤在底部。本脚本在这批子集里再找「还能区分 T+1 胜率」的共振外因子。
 *
 * 口径：当前生产门槛（含确认日缩量<=1.0）；2024~2026 剔924；板块共振逐日重算
 *   （概念成分用当前快照，有前视偏差）。只统计 hitCount=0 的信号。
 *
 * 用法：
 *   npx tsx scripts/backtest-xianren-withinbulk-gradient.ts --years 2024,2025,2026
 */

import { prisma } from '../lib/db';
import { detectXianRenAt, DEFAULT_XIANREN_CONFIG, XianRenBar } from '../lib/strategy/xian-ren-zhi-lu';

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

const EXCLUDE_LO = '2024-09-24';
const EXCLUDE_HI = '2024-10-08';

const round = (n: number, d = 2): number => {
  const p = Math.pow(10, d);
  return Math.round(n * p) / p;
};

const fmtDate = (d: string): string =>
  d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d;

interface Cell {
  n: number; t1Win: number; t1Sum: number; t5Win: number; t5Sum: number; t5gt2: number;
}
const emptyCell = (): Cell => ({ n: 0, t1Win: 0, t1Sum: 0, t5Win: 0, t5Sum: 0, t5gt2: 0 });
const cellOut = (c: Cell) => ({
  n: c.n,
  t1WinRate: c.n ? round((c.t1Win / c.n) * 100) : null,
  t1Mean: c.n ? round(c.t1Sum / c.n) : null,
  t5WinRate: c.n ? round((c.t5Win / c.n) * 100) : null,
  t5Mean: c.n ? round(c.t5Sum / c.n) : null,
  t5gt2Pct: c.n ? round((c.t5gt2 / c.n) * 100) : null,
});

interface M {
  confPct: number; confDayGain: number; gain60: number; upperShadowPct: number;
  changePct: number; amplitudePct: number; bodyAbsPct: number; volRatio: number;
  shadowRatio: number; confTurnover: number | null; confOpenGap: number; confClosePos: number;
  t0NearHigh20: number; confToT0Vol: number; circMvYi: number | null;
}

interface Factor { name: string; buckets: string[]; get: (m: M) => number | null; edges: number[]; }
const b = (v: number, edges: number[], labels: string[]) => {
  for (let i = 0; i < edges.length; i++) if (v < edges[i]) return labels[i];
  return labels[labels.length - 1];
};

const FACTORS: (Factor & { assign: (m: M) => string | null })[] = [
  { name: 'confDayGain', edges: [1, 2, 3, 5], buckets: ['<1', '1-2', '2-3', '3-5', '>=5'], get: (m) => m.confDayGain, assign: (m) => b(m.confDayGain, [1, 2, 3, 5], ['<1', '1-2', '2-3', '3-5', '>=5']) },
  { name: 'confToT0Vol', edges: [0.5, 1, 2], buckets: ['<0.5', '0.5-1', '1-2', '>=2'], get: (m) => m.confToT0Vol, assign: (m) => b(m.confToT0Vol, [0.5, 1, 2], ['<0.5', '0.5-1', '1-2', '>=2']) },
  { name: 'confTurnover', edges: [3, 5, 10], buckets: ['<3', '3-5', '5-10', '>=10'], get: (m) => m.confTurnover, assign: (m) => (m.confTurnover == null ? null : b(m.confTurnover, [3, 5, 10], ['<3', '3-5', '5-10', '>=10'])) },
  { name: 'confPct', edges: [50, 60, 80, 100], buckets: ['40-50', '50-60', '60-80', '80-100', '>=100'], get: (m) => m.confPct, assign: (m) => b(m.confPct, [50, 60, 80, 100], ['40-50', '50-60', '60-80', '80-100', '>=100']) },
  { name: 'upperShadowPct', edges: [2, 2.5, 3, 4], buckets: ['1.5-2', '2-2.5', '2.5-3', '3-4', '>=4'], get: (m) => m.upperShadowPct, assign: (m) => b(m.upperShadowPct, [2, 2.5, 3, 4], ['1.5-2', '2-2.5', '2.5-3', '3-4', '>=4']) },
  { name: 'changePct', edges: [0.5, 1, 2, 3], buckets: ['0-0.5', '0.5-1', '1-2', '2-3', '3-5'], get: (m) => m.changePct, assign: (m) => b(m.changePct, [0.5, 1, 2, 3], ['0-0.5', '0.5-1', '1-2', '2-3', '3-5']) },
  { name: 'amplitudePct', edges: [3, 4], buckets: ['<=3', '3-4', '4-5'], get: (m) => m.amplitudePct, assign: (m) => b(m.amplitudePct, [3, 4], ['<=3', '3-4', '4-5']) },
  { name: 'bodyAbsPct', edges: [0.5, 1, 1.5], buckets: ['<=0.5', '0.5-1', '1-1.5', '1.5-2'], get: (m) => m.bodyAbsPct, assign: (m) => b(m.bodyAbsPct, [0.5, 1, 1.5], ['<=0.5', '0.5-1', '1-1.5', '1.5-2']) },
  { name: 'volRatio(试盘)', edges: [0.8, 1.2, 2, 3], buckets: ['<0.8', '0.8-1.2', '1.2-2', '2-3', '>=3'], get: (m) => m.volRatio, assign: (m) => b(m.volRatio, [0.8, 1.2, 2, 3], ['<0.8', '0.8-1.2', '1.2-2', '2-3', '>=3']) },
  { name: 'shadowRatio', edges: [2, 3, 5], buckets: ['1.2-2', '2-3', '3-5', '>=5'], get: (m) => m.shadowRatio, assign: (m) => b(m.shadowRatio, [2, 3, 5], ['1.2-2', '2-3', '3-5', '>=5']) },
  { name: 'gain60', edges: [-10, 0, 10, 20], buckets: ['<=-10', '-10-0', '0-10', '10-20', '20-30'], get: (m) => m.gain60, assign: (m) => b(m.gain60, [-10, 0, 10, 20], ['<=-10', '-10-0', '0-10', '10-20', '20-30']) },
  { name: 't0NearHigh20', edges: [0, 2], buckets: ['<0', '0-2', '>=2'], get: (m) => m.t0NearHigh20, assign: (m) => b(m.t0NearHigh20, [0, 2], ['<0', '0-2', '>=2']) },
  { name: 'circMvYi', edges: [30, 50, 100], buckets: ['<30', '30-50', '50-100', '>=100'], get: (m) => m.circMvYi, assign: (m) => (m.circMvYi == null ? null : b(m.circMvYi, [30, 50, 100], ['<30', '30-50', '50-100', '>=100'])) },
  { name: 'confOpenGap', edges: [0, 0.5], buckets: ['<=0', '0-0.5', '0.5-1.0'], get: (m) => m.confOpenGap, assign: (m) => b(m.confOpenGap, [0, 0.5], ['<=0', '0-0.5', '0.5-1.0']) },
  { name: 'confClosePos', edges: [0.8, 0.9], buckets: ['0.7-0.8', '0.8-0.9', '0.9-1.0'], get: (m) => m.confClosePos, assign: (m) => b(m.confClosePos, [0.8, 0.9], ['0.7-0.8', '0.8-0.9', '0.9-1.0']) },
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

async function loadConceptMembers(): Promise<Map<string, string[]>> {
  const rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT m.thscode, m.ts_code FROM ths_index_member m
     JOIN ths_index i ON i.thscode = m.thscode WHERE i.tag = 'cn_concept'`
  );
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const ths = String(r.thscode), ts = String(r.ts_code);
    if (!ths || !ts) continue;
    if (!out.has(ts)) out.set(ts, []);
    out.get(ts)!.push(ths);
  }
  return out;
}

async function loadConceptHits(loadStart: string, loadEnd: string): Promise<Map<string, Set<string>>> {
  const rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT d.ts_code, d.trade_date, d.open, d.high, d.close, d.vol
     FROM ths_index_daily d
     JOIN ths_index i ON i.thscode = d.ts_code AND i.tag = 'cn_concept'
     WHERE d.trade_date >= $1 AND d.trade_date <= $2
     ORDER BY d.ts_code, d.trade_date`,
    loadStart, loadEnd
  );
  const byCode = new Map<string, { date: string; open: number; high: number; close: number; vol: number }[]>();
  for (const r of rows) {
    if (r.open == null || r.high == null || r.close == null) continue;
    const code = String(r.ts_code);
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code)!.push({ date: fmtDate(String(r.trade_date)), open: Number(r.open), high: Number(r.high), close: Number(r.close), vol: Number(r.vol ?? 0) });
  }
  const out = new Map<string, Set<string>>();
  for (const [code, bars] of byCode) {
    const hits = new Set<string>();
    for (let i = 1; i < bars.length; i++) {
      const t0 = bars[i - 1], t = bars[i];
      const shadowTop = Math.max(t0.open, t0.close);
      if (!(t0.high > shadowTop) || t0.close <= 0) continue;
      if (((t0.high - shadowTop) / t0.close) * 100 < 1.5) continue;
      if (t.close < t0.close + (t0.high - t0.close) * 0.5) continue;
      hits.add(t.date);
    }
    out.set(code, hits);
  }
  return out;
}

type Acc = Record<string, Record<string, Cell>>;
const emptyAcc = (): Acc => {
  const o: Acc = {};
  for (const f of FACTORS) { o[f.name] = {}; for (const x of f.buckets) o[f.name][x] = emptyCell(); }
  return o;
};

function processRaw(raw: RawBar[], year: string, acc: Acc, conceptsOf: Map<string, string[]>, conceptHits: Map<string, Set<string>>): void {
  const byCode = new Map<string, RawBar[]>();
  for (const r of raw) {
    if (r.open == null || r.close == null || r.high == null || r.low == null) continue;
    if (!byCode.has(r.tsCode)) byCode.set(r.tsCode, []);
    byCode.get(r.tsCode)!.push(r);
  }
  for (const [code, rawBars] of byCode) {
    rawBars.sort((a, b) => (a.tradeDate < b.tradeDate ? -1 : 1));
    const bars: XianRenBar[] = rawBars.map((r) => ({
      date: fmtDate(r.tradeDate), open: r.open as number, high: r.high as number, low: r.low as number, close: r.close as number,
      volume: Number(r.vol ?? 0), preClose: r.preClose != null ? Number(r.preClose) : null,
      turnoverRate: r.turnoverRate != null ? Number(r.turnoverRate) : null,
    }));
    const concepts = conceptsOf.get(code) ?? [];

    for (let i = 61; i < bars.length; i++) {
      const t0 = bars[i - 1], t1 = bars[i];
      const upperShadow = t0.high - Math.max(t0.open, t0.close);
      if ((upperShadow / t0.open) * 100 < 1.5) continue;
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

      // 板块共振：只保留 hitCount=0
      let hitCount = 0;
      for (const c of concepts) if (conceptHits.get(c)?.has(sig.entryDate)) { hitCount += 1; break; }
      if (hitCount > 0) continue;

      const entry = sig.entryPrice;
      if (!entry || entry <= 0) continue;
      const b1 = bars[i + 1];
      if (!b1) continue;
      const retT1 = ((b1.high - entry) / entry) * 100;
      let cumHigh = -Infinity;
      let ok = true;
      for (let n = 1; n <= 5; n++) {
        const bb = bars[i + n];
        if (!bb) { ok = false; break; }
        if (bb.high > cumHigh) cumHigh = bb.high;
      }
      if (!ok) continue;
      const retT5 = ((cumHigh - entry) / entry) * 100;

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
      const confToT0Vol = t0.volume > 0 ? t1.volume / t0.volume : 0;
      let maxHigh20 = -Infinity;
      for (let j = i - 20; j < i - 1; j++) if (bars[j].high > maxHigh20) maxHigh20 = bars[j].high;
      const t0NearHigh20 = maxHigh20 > 0 ? (t0.high / maxHigh20 - 1) * 100 : 0;
      const circMvYi = rawBars[i].circMv != null ? round(Number(rawBars[i].circMv) / 10000, 1) : null;

      const m: M = {
        confPct: confPctPct, confDayGain, gain60, upperShadowPct: (upperShadow / t0.open) * 100,
        changePct, amplitudePct, bodyAbsPct, volRatio, shadowRatio, confTurnover: t1.turnoverRate ?? null,
        confOpenGap, confClosePos, t0NearHigh20, confToT0Vol, circMvYi,
      };

      for (const f of FACTORS) {
        const label = f.assign(m);
        if (label == null) continue;
        const cell = acc[f.name][label];
        if (!cell) continue;
        cell.n += 1;
        if (retT1 > 0) cell.t1Win += 1;
        cell.t1Sum += retT1;
        if (retT5 > 0) cell.t5Win += 1;
        if (retT5 > 2) cell.t5gt2 += 1;
        cell.t5Sum += retT5;
      }
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const yearsArg = args.includes('--years') ? args[args.indexOf('--years') + 1] : undefined;
  const YEARS = yearsArg ? yearsArg.split(',') : ['2024', '2025', '2026'];

  const latestRow = await prisma.dailyBar.findFirst({ orderBy: { tradeDate: 'desc' }, select: { tradeDate: true } });
  if (!latestRow) throw new Error('no daily bars');
  const latestDate = latestRow.tradeDate;

  const t0 = Date.now();
  const conceptsOf = await loadConceptMembers();
  const yn = YEARS.map(Number).sort((a, b) => a - b);
  const conceptHits = await loadConceptHits(`${yn[0] - 1}0901`, `${yn[yn.length - 1] + 1}0110`);
  console.log('concept data loaded, elapsed', Date.now() - t0, 'ms');

  const acc = emptyAcc();
  for (const year of YEARS) {
    const loadStart = `${Number(year) - 1}0901`;
    const loadEndRaw = `${Number(year) + 1}0110`;
    const loadEnd = loadEndRaw < latestDate ? loadEndRaw : latestDate;
    const raw = await loadBars(loadStart, loadEnd);
    processRaw(raw, year, acc, conceptsOf, conceptHits);
    console.log('year', year, 'loaded', raw.length, 'elapsed', Date.now() - t0, 'ms');
  }

  const total = Object.values(acc['confDayGain']).reduce((a, c) => a + c.n, 0);
  console.log('\n=== 无共振子集因子梯度（hitCount=0，主口径 T+1 胜率）===');
  console.log('total hitCount=0 signals =', total);
  for (const f of FACTORS) {
    console.log('\n## ' + f.name);
    for (const x of f.buckets) console.log('  ' + x.padEnd(10), JSON.stringify(cellOut(acc[f.name][x])));
  }
  console.log('\ntotal elapsed', Date.now() - t0, 'ms');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
