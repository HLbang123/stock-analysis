/**
 * 仙人指路 — 分数段 × T+5 累计收益均值（最近 3 年，剔 924）
 *
 * 口径：
 *   - 样本：2024 / 2025 / 2026，剔除 924（信号日 2024-09-24 ~ 2024-10-08）。
 *   - 信号：当前生产配置 DEFAULT_XIANREN_CONFIG（volRatioMin=0、上影1.5、反包40、收盘位0.7、高开<=1、确认日缩量<=1.0）。
 *   - 打分：直接调用生产 scoreCandidate（板块共振 hitCount/maxShadow/sectorVolRatioT + 小市值 circMvYi + 高换手 confTurnover）。
 *   - 板块共振：用 ths_index_daily(cn_concept) 逐日重算「概念指数 T-1 上影>=1.5% 且 T 反包上影>=50%」，
 *     成分用 ths_index_member 当前快照（有前视偏差，与上一轮定稿同口径）。
 *   - 收益：T+N 累计最高 = (max(T+1..T+N high) - entry)/entry，entry = T1 收盘；输出 N=1..5 的均值。
 *
 * 用法：
 *   npx tsx scripts/backtest-xianren-score-bands.ts --selftest
 *   npx tsx scripts/backtest-xianren-score-bands.ts
 */

import { prisma } from '../lib/db';
import { detectXianRenAt, DEFAULT_XIANREN_CONFIG, XianRenBar } from '../lib/strategy/xian-ren-zhi-lu';
import { scoreCandidate } from '../services/short-term-strategies/score';

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

const DEFAULT_YEARS = ['2024', '2025', '2026'];
const EXCLUDE_LO = '2024-09-24';
const EXCLUDE_HI = '2024-10-08';

const BANDS: [number, number][] = [
  [0, 19], [20, 39], [40, 59], [60, 79], [80, 100],
];

const round = (n: number, d = 2): number => {
  const p = Math.pow(10, d);
  return Math.round(n * p) / p;
};

const fmtDate = (d: string): string =>
  d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d;

interface Cell {
  cum: number[][]; // cum[N-1] = 该档全部样本的 T+N 累计最高收益
  t1Win: number;
  t5Win: number;
  t5gt2: number;
}

function emptyCell(): Cell {
  return { cum: [[], [], [], [], []], t1Win: 0, t5Win: 0, t5gt2: 0 };
}

function median(arr: number[]): number {
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function cellOut(c: Cell) {
  const n = c.cum[0].length;
  return {
    n,
    t1WinRate: n ? round((c.t1Win / n) * 100) : null,
    t5WinRate: n ? round((c.t5Win / n) * 100) : null,
    t5gt2Pct: n ? round((c.t5gt2 / n) * 100) : null,
    cumMean: n ? c.cum.map((a) => round(a.reduce((x, y) => x + y, 0) / a.length)) : [null, null, null, null, null],
    cumMedian: n ? c.cum.map((a) => round(median(a))) : [null, null, null, null, null],
  };
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

/** 当前概念成分：tsCode -> 概念 thscode[] */
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

/** 每个概念在每个日期 D 是否「命中」（T-1 上影>=1.5% 且 T 反包>=50%），命中则给出 shadow / volRatioT */
async function loadConceptHits(loadStart: string, loadEnd: string): Promise<Map<string, Map<string, { shadow: number; volRatioT: number | null }>>> {
  const rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT d.ts_code, d.trade_date, d.open, d.high, d.close, d.vol
     FROM ths_index_daily d
     JOIN ths_index i ON i.thscode = d.ts_code AND i.tag = 'cn_concept'
     WHERE d.trade_date >= $1 AND d.trade_date <= $2
     ORDER BY d.ts_code, d.trade_date`,
    loadStart,
    loadEnd
  );
  const byCode = new Map<string, { date: string; open: number; high: number; close: number; vol: number }[]>();
  for (const r of rows) {
    if (r.open == null || r.high == null || r.close == null) continue;
    const code = String(r.ts_code);
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code)!.push({
      date: fmtDate(String(r.trade_date)),
      open: Number(r.open), high: Number(r.high), close: Number(r.close), vol: Number(r.vol ?? 0),
    });
  }
  const out = new Map<string, Map<string, { shadow: number; volRatioT: number | null }>>();
  for (const [code, bars] of byCode) {
    const hits = new Map<string, { shadow: number; volRatioT: number | null }>();
    for (let i = 1; i < bars.length; i++) {
      const t0 = bars[i - 1];
      const t = bars[i];
      const shadowTop = Math.max(t0.open, t0.close);
      if (!(t0.high > shadowTop) || t0.close <= 0) continue;
      const shadowPct = ((t0.high - shadowTop) / t0.close) * 100;
      if (shadowPct < 1.5) continue;
      if (t.close < t0.close + (t0.high - t0.close) * 0.5) continue;
      let volRatioT: number | null = null;
      const prev5 = bars.slice(Math.max(0, i - 5), i).map((b) => b.vol).filter((v) => v > 0);
      if (prev5.length >= 3) {
        const avg = prev5.reduce((a, b) => a + b, 0) / prev5.length;
        if (avg > 0) volRatioT = round(t.vol / avg);
      }
      hits.set(t.date, { shadow: shadowPct, volRatioT });
    }
    out.set(code, hits);
  }
  return out;
}

interface Acc {
  exact: Map<number, Cell>; // 每个整数分数
  bands: Cell[];            // 与 BANDS 对应
}

function emptyAcc(): Acc {
  return { exact: new Map(), bands: BANDS.map(() => emptyCell()) };
}

function push(acc: Acc, score: number, cum: number[]): void {
  const t1 = cum[0], t5 = cum[4];
  const upd = (c: Cell) => {
    for (let k = 0; k < 5; k++) c.cum[k].push(cum[k]);
    if (t1 > 0) c.t1Win += 1;
    if (t5 > 0) c.t5Win += 1;
    if (t5 > 2) c.t5gt2 += 1;
  };
  let e = acc.exact.get(score);
  if (!e) { e = emptyCell(); acc.exact.set(score, e); }
  upd(e);
  const bi = BANDS.findIndex(([lo, hi]) => score >= lo && score <= hi);
  if (bi >= 0) upd(acc.bands[bi]);
}

function processRaw(
  raw: RawBar[],
  year: string,
  acc: Acc,
  conceptsOf: Map<string, string[]>,
  conceptHits: Map<string, Map<string, { shadow: number; volRatioT: number | null }>>
): void {
  const byCode = new Map<string, RawBar[]>();
  for (const r of raw) {
    if (r.open == null || r.close == null || r.high == null || r.low == null) continue;
    if (!byCode.has(r.tsCode)) byCode.set(r.tsCode, []);
    byCode.get(r.tsCode)!.push(r);
  }

  for (const [code, rawBars] of byCode) {
    rawBars.sort((a, b) => (a.tradeDate < b.tradeDate ? -1 : 1));
    const bars: XianRenBar[] = rawBars.map((r) => ({
      date: fmtDate(r.tradeDate),
      open: r.open as number, high: r.high as number, low: r.low as number, close: r.close as number,
      volume: Number(r.vol ?? 0),
      preClose: r.preClose != null ? Number(r.preClose) : null,
      turnoverRate: r.turnoverRate != null ? Number(r.turnoverRate) : null,
    }));
    const concepts = conceptsOf.get(code) ?? [];

    for (let i = 61; i < bars.length; i++) {
      const t0 = bars[i - 1];
      const t1 = bars[i];

      // 前置闸门（当前生产门槛超集）
      const upperShadow = t0.high - Math.max(t0.open, t0.close);
      if ((upperShadow / t0.open) * 100 < 1.5) continue;
      const confPctPct = upperShadow > 0 ? ((t1.close - t0.close) / upperShadow) * 100 : 0;
      if (confPctPct < 40) continue;
      const confClosePos = t1.high > t1.low ? (t1.close - t1.low) / (t1.high - t1.low) : 0.5;
      if (confClosePos < 0.7) continue;
      if (((t1.open - t0.close) / t0.close) * 100 > 1.0) continue;

      const sig = detectXianRenAt(bars, i, DEFAULT_XIANREN_CONFIG);
      if (!sig.matched) continue;
      if (sig.entryDate.slice(0, 4) !== year) continue;
      if (sig.entryDate >= EXCLUDE_LO && sig.entryDate <= EXCLUDE_HI) continue;

      const entry = sig.entryPrice;
      if (!entry || entry <= 0) continue;
      const b1 = bars[i + 1];
      if (!b1) continue;
      const cum: number[] = [];
      let cumHigh = -Infinity;
      let ok = true;
      for (let n = 1; n <= 5; n++) {
        const b = bars[i + n];
        if (!b) { ok = false; break; }
        if (b.high > cumHigh) cumHigh = b.high;
        cum.push(((cumHigh - entry) / entry) * 100);
      }
      if (!ok) continue;

      // 板块共振（逐日）
      let hitCount = 0, maxShadow = 0, sectorVolRatioT: number | null = null;
      for (const c of concepts) {
        const h = conceptHits.get(c)?.get(sig.entryDate);
        if (!h) continue;
        hitCount += 1;
        if (h.shadow > maxShadow) { maxShadow = h.shadow; sectorVolRatioT = h.volRatioT; }
      }

      const circMvYi = rawBars[i].circMv != null ? round(Number(rawBars[i].circMv) / 10000, 1) : null;
      const prevClose0 = t0.preClose != null && t0.preClose > 0 ? t0.preClose : bars[i - 2].close;
      const changePct = ((t0.close - prevClose0) / prevClose0) * 100;
      const gain60 = ((prevClose0 / bars[i - 61].close) - 1) * 100;
      const metrics: Record<string, unknown> = {
        hitCount, maxShadow, circMvYi, changePct, gain60, confTurnover: t1.turnoverRate ?? null,
      };
      if (sectorVolRatioT != null) metrics.sectorVolRatioT = sectorVolRatioT;

      const score = scoreCandidate({ strategy: 'xian-ren-zhi-lu', metrics, priority: 'medium' } as any);
      push(acc, score, cum);
    }
  }
}

function selfTest(): void {
  // 打分函数冒烟：不同 metrics 组合的分数
  const cases = [
    { hitCount: 0, maxShadow: 0, circMvYi: 25, confTurnover: 2 },
    { hitCount: 2, maxShadow: 2.1, circMvYi: 25, confTurnover: 2, sectorVolRatioT: 0.8 },
    { hitCount: 4, maxShadow: 2.6, circMvYi: 600, confTurnover: 12, sectorVolRatioT: 1.2 },
  ];
  for (const m of cases) {
    console.log(JSON.stringify(m), '=>', scoreCandidate({ strategy: 'xian-ren-zhi-lu', metrics: m, priority: 'medium' } as any));
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) { selfTest(); return; }
  const yearsArg = args.includes('--years') ? args[args.indexOf('--years') + 1] : undefined;
  const YEARS = yearsArg ? yearsArg.split(',') : DEFAULT_YEARS;

  const latestRow = await prisma.dailyBar.findFirst({ orderBy: { tradeDate: 'desc' }, select: { tradeDate: true } });
  if (!latestRow) throw new Error('no daily bars');
  const latestDate = latestRow.tradeDate;

  const t0 = Date.now();
  const conceptsOf = await loadConceptMembers();
  console.log('concept members loaded:', conceptsOf.size, 'stocks, elapsed', Date.now() - t0, 'ms');
  const yearsNum = YEARS.map(Number).sort((a, b) => a - b);
  const sectorStart = `${yearsNum[0] - 1}0901`;
  const sectorEnd = `${yearsNum[yearsNum.length - 1] + 1}0110`;
  const conceptHits = await loadConceptHits(sectorStart, sectorEnd);
  console.log('concept hits loaded:', conceptHits.size, 'concepts, elapsed', Date.now() - t0, 'ms');

  const acc = emptyAcc();
  for (const year of YEARS) {
    const loadStart = `${Number(year) - 1}0901`;
    const loadEndRaw = `${Number(year) + 1}0110`;
    const loadEnd = loadEndRaw < latestDate ? loadEndRaw : latestDate;
    const raw = await loadBars(loadStart, loadEnd);
    processRaw(raw, year, acc, conceptsOf, conceptHits);
    console.log('year', year, 'loaded', raw.length, 'elapsed', Date.now() - t0, 'ms');
  }

  console.log('\n=== 分数段 × T+N 累计最高收益（均值+中位数，2024-2026，剔924，当前生产门槛）===');
  const total = [...acc.exact.values()].reduce((a, c) => a + c.cum[0].length, 0);
  console.log('total signals =', total);
  for (let bi = 0; bi < BANDS.length; bi++) {
    const [lo, hi] = BANDS[bi];
    console.log(`[${lo}-${hi}]`.padEnd(9), JSON.stringify(cellOut(acc.bands[bi])));
  }

  console.log('\n=== 每个整数分数的分布（便于再分档）===');
  const exact: Record<string, unknown> = {};
  for (const score of [...acc.exact.keys()].sort((a, b) => a - b)) {
    exact[String(score)] = cellOut(acc.exact.get(score)!);
  }
  console.log(JSON.stringify(exact, null, 2));

  console.log('\ntotal elapsed', Date.now() - t0, 'ms');
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
