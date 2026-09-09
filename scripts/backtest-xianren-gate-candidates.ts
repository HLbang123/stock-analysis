/**
 * 仙人指路 — 候选硬门槛验证（冲高口径，剔 924，2022~2026 五年）
 *
 * 基于 factor-scan 的结论，对「能明显提升胜率」的候选硬门槛做 单门槛 + 组合 验证：
 *   G_cv1  : 确认日量比 confVolRatio < 1.0（缩量确认）
 *   G_cv08 : 确认日量比 confVolRatio < 0.8
 *   G_circ30 : 流通市值 < 30 亿
 *   G_circ50 : 流通市值 < 50 亿
 *   G_cg2  : 确认日涨幅 confDayGain < 2%
 *   G_ct3  : 确认日换手 confTurnover < 3%
 *   以及若干组合。
 *
 * 固定基线 = 当前生产 DEFAULT_XIANREN_CONFIG。不落 chip（peakPos 非本轮候选）。
 * 收益口径 = 冲高：T+1 当日最高 + T+5 累计最高（胜率>0、均值）+ T+5>2%。
 *
 * 用法：
 *   npx tsx scripts/backtest-xianren-gate-candidates.ts --selftest
 *   npx tsx scripts/backtest-xianren-gate-candidates.ts
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

const YEARS = ['2022', '2023', '2024', '2025', '2026'];
const EXCLUDE_LO = '2024-09-24';
const EXCLUDE_HI = '2024-10-08';

const round = (n: number, d = 2): number => {
  const p = Math.pow(10, d);
  return Math.round(n * p) / p;
};

const fmtDate = (d: string): string =>
  d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d;

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

interface M {
  confVolRatio: number;
  confToT0Vol: number;
  confTurnover: number | null;
  circMvYi: number | null;
  confDayGain: number;
}

interface Gate {
  name: string;
  pass: (m: M) => boolean;
}

const GATES: Gate[] = [
  { name: 'base', pass: () => true },
  { name: 'cv<1.0', pass: (m) => m.confVolRatio < 1.0 },
  { name: 'cv<0.8', pass: (m) => m.confVolRatio < 0.8 },
  { name: 'circ<30', pass: (m) => m.circMvYi != null && m.circMvYi < 30 },
  { name: 'circ<50', pass: (m) => m.circMvYi != null && m.circMvYi < 50 },
  { name: 'cg<2', pass: (m) => m.confDayGain < 2 },
  { name: 'ct<3', pass: (m) => m.confTurnover != null && m.confTurnover < 3 },
  { name: 'cv<1.0&circ<50', pass: (m) => m.confVolRatio < 1.0 && m.circMvYi != null && m.circMvYi < 50 },
  { name: 'cv<1.0&circ<30', pass: (m) => m.confVolRatio < 1.0 && m.circMvYi != null && m.circMvYi < 30 },
  { name: 'cv<1.0&cg<2', pass: (m) => m.confVolRatio < 1.0 && m.confDayGain < 2 },
  { name: 'cv<1.0&ct<3', pass: (m) => m.confVolRatio < 1.0 && m.confTurnover != null && m.confTurnover < 3 },
  { name: 'cv<1.0&circ<50&cg<2', pass: (m) => m.confVolRatio < 1.0 && m.circMvYi != null && m.circMvYi < 50 && m.confDayGain < 2 },
];

interface Cell {
  t1: number[];
  t5cum: number[];
}

type GateAcc = {
  overall: Cell;
  byYear: Record<string, Cell>;
};

function emptyGateAcc(): GateAcc {
  return { overall: { t1: [], t5cum: [] }, byYear: {} };
}

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

function processRaw(raw: RawBar[], year: string, acc: Record<string, GateAcc>): void {
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

      let cvs = 0, cvc = 0;
      for (let j = i - 5; j < i; j++) { cvs += bars[j].volume; cvc++; }
      const confVolRatio = cvc > 0 ? t1.volume / (cvs / cvc) : 0;
      const confToT0Vol = t0.volume > 0 ? t1.volume / t0.volume : 0;
      const confDayGain = ((t1.close - t0.close) / t0.close) * 100;
      const m: M = {
        confVolRatio,
        confToT0Vol,
        confTurnover: t1.turnoverRate ?? null,
        circMvYi: rawBars[i].circMv != null ? Number(rawBars[i].circMv) / 10000 : null,
        confDayGain,
      };

      for (const g of GATES) {
        if (!g.pass(m)) continue;
        const a = acc[g.name];
        a.overall.t1.push(retT1);
        a.overall.t5cum.push(retT5Cum);
        let y = a.byYear[year];
        if (!y) { y = { t1: [], t5cum: [] }; a.byYear[year] = y; }
        y.t1.push(retT1);
        y.t5cum.push(retT5Cum);
      }
    }
  }
}

function selfTest(): void {
  const m: M = { confVolRatio: 0.7, confToT0Vol: 0.6, confTurnover: 2.5, circMvYi: 25, confDayGain: 1.5 };
  for (const g of GATES) console.log(g.name, '=>', g.pass(m));
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

  const acc: Record<string, GateAcc> = {};
  for (const g of GATES) acc[g.name] = emptyGateAcc();

  const t0 = Date.now();
  for (const year of YEARS) {
    const loadStart = `${Number(year) - 1}0901`;
    const loadEndRaw = `${Number(year) + 1}0110`;
    const loadEnd = loadEndRaw < latestDate ? loadEndRaw : latestDate;
    const raw = await loadBars(loadStart, loadEnd);
    processRaw(raw, year, acc);
    console.log('year', year, 'window', loadStart, '->', loadEnd, 'loaded', raw.length, 'elapsed', Date.now() - t0, 'ms');
  }

  console.log('\n=== 候选门槛 汇总（剔924，2022-2026）===');
  for (const g of GATES) {
    const a = acc[g.name];
    console.log(g.name, JSON.stringify({
      n: a.overall.t1.length,
      t1: stats(a.overall.t1),
      t5cum: stats(a.overall.t5cum),
      t5gt2Pct: gt2Pct(a.overall.t5cum),
    }));
  }

  console.log('\n=== 候选门槛 逐年（n / T1win / T5win / T5>2%）===');
  for (const g of GATES) {
    const a = acc[g.name];
    const by = Object.fromEntries(YEARS.map((y) => {
      const c = a.byYear[y];
      return [y, c ? {
        n: c.t1.length,
        t1WinRate: stats(c.t1).winRate,
        t5WinRate: stats(c.t5cum).winRate,
        t5gt2Pct: gt2Pct(c.t5cum),
      } : { n: 0 }];
    }));
    console.log('\n## ' + g.name);
    console.log(JSON.stringify(by, null, 2));
  }

  console.log('\ntotal elapsed', Date.now() - t0, 'ms');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
