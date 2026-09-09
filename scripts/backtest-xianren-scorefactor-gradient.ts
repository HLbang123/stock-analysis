/**
 * 仙人指路 — 打分因子梯度复验（主口径：T+1 冲高胜率）
 *
 * 目的：在「当前生产门槛」的信号池上，对 scoreCandidate 的 5 个因子逐档看
 *   T+1 冲高胜率（主）、T+1 均值，以及 T+5 累计胜率/均值/T+5>2%（辅），
 *   判断每个因子的方向是否单调、权重该不该重推。
 *
 * 口径：2024~2026，剔 924；信号 = DEFAULT_XIANREN_CONFIG（含确认日缩量<=1.0）；
 *   板块共振逐日重算（概念成分用当前快照，有前视偏差，与定稿同口径）。
 *
 * 用法：
 *   npx tsx scripts/backtest-xianren-scorefactor-gradient.ts --selftest
 *   npx tsx scripts/backtest-xianren-scorefactor-gradient.ts
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

const YEARS = ['2024', '2025', '2026'];
const EXCLUDE_LO = '2024-09-24';
const EXCLUDE_HI = '2024-10-08';
const SECTOR_LOAD_START = '20230901';
const SECTOR_LOAD_END = '20270110';

const round = (n: number, d = 2): number => {
  const p = Math.pow(10, d);
  return Math.round(n * p) / p;
};

const fmtDate = (d: string): string =>
  d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d;

interface Cell {
  n: number;
  t1Win: number;
  t1Sum: number;
  t5Win: number;
  t5Sum: number;
  t5gt2: number;
}

function emptyCell(): Cell {
  return { n: 0, t1Win: 0, t1Sum: 0, t5Win: 0, t5Sum: 0, t5gt2: 0 };
}

function cellOut(c: Cell) {
  return {
    n: c.n,
    t1WinRate: c.n ? round((c.t1Win / c.n) * 100) : null,
    t1Mean: c.n ? round(c.t1Sum / c.n) : null,
    t5WinRate: c.n ? round((c.t5Win / c.n) * 100) : null,
    t5Mean: c.n ? round(c.t5Sum / c.n) : null,
    t5gt2Pct: c.n ? round((c.t5gt2 / c.n) * 100) : null,
  };
}

interface FactorDef {
  name: string;
  buckets: string[];
  assign: (f: { hitCount: number; maxShadow: number; sectorVolRatioT: number | null; circMvYi: number | null; confTurnover: number | null }) => string;
}

const FACTORS: FactorDef[] = [
  { name: 'hitCount', buckets: ['0', '1', '2', '3', '4+'], assign: (f) => (f.hitCount >= 4 ? '4+' : String(f.hitCount)) },
  { name: 'maxShadow', buckets: ['0(无命中)', '1.5-2', '2-2.5', '2.5+'], assign: (f) => {
      if (f.hitCount === 0) return '0(无命中)';
      if (f.maxShadow >= 2.5) return '2.5+';
      if (f.maxShadow >= 2) return '2-2.5';
      return '1.5-2';
    } },
  { name: 'sectorVolRatioT', buckets: ['无命中', '<1.0', '>=1.0'], assign: (f) => {
      if (f.hitCount === 0 || f.sectorVolRatioT == null) return '无命中';
      return f.sectorVolRatioT < 1.0 ? '<1.0' : '>=1.0';
    } },
  { name: 'circMvYi', buckets: ['<30亿', '30-50亿', '50-100亿', '>=100亿'], assign: (f) => {
      if (f.circMvYi == null) return '>=100亿'; // 缺失极少，归入最大档
      if (f.circMvYi < 30) return '<30亿';
      if (f.circMvYi < 50) return '30-50亿';
      if (f.circMvYi < 100) return '50-100亿';
      return '>=100亿';
    } },
  { name: 'confTurnover', buckets: ['<3', '3-5', '5-10', '>=10'], assign: (f) => {
      if (f.confTurnover == null) return '<3';
      if (f.confTurnover < 3) return '<3';
      if (f.confTurnover < 5) return '3-5';
      if (f.confTurnover < 10) return '5-10';
      return '>=10';
    } },
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

async function loadConceptHits(): Promise<Map<string, Map<string, { shadow: number; volRatioT: number | null }>>> {
  const rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT d.ts_code, d.trade_date, d.open, d.high, d.close, d.vol
     FROM ths_index_daily d
     JOIN ths_index i ON i.thscode = d.ts_code AND i.tag = 'cn_concept'
     WHERE d.trade_date >= $1 AND d.trade_date <= $2
     ORDER BY d.ts_code, d.trade_date`,
    SECTOR_LOAD_START,
    SECTOR_LOAD_END
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
      const t0 = bars[i - 1], t = bars[i];
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

type Acc = Record<string, Record<string, Cell>>;

function emptyAcc(): Acc {
  const out: Acc = {};
  for (const f of FACTORS) {
    out[f.name] = {};
    for (const b of f.buckets) out[f.name][b] = emptyCell();
  }
  return out;
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
      const t0 = bars[i - 1], t1 = bars[i];
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
      const retT1 = ((b1.high - entry) / entry) * 100;
      let cumHigh = -Infinity;
      let ok = true;
      for (let n = 1; n <= 5; n++) {
        const b = bars[i + n];
        if (!b) { ok = false; break; }
        if (b.high > cumHigh) cumHigh = b.high;
      }
      if (!ok) continue;
      const retT5 = ((cumHigh - entry) / entry) * 100;

      let hitCount = 0, maxShadow = 0, sectorVolRatioT: number | null = null;
      for (const c of concepts) {
        const h = conceptHits.get(c)?.get(sig.entryDate);
        if (!h) continue;
        hitCount += 1;
        if (h.shadow > maxShadow) { maxShadow = h.shadow; sectorVolRatioT = h.volRatioT; }
      }

      const fv = {
        hitCount,
        maxShadow,
        sectorVolRatioT,
        circMvYi: rawBars[i].circMv != null ? round(Number(rawBars[i].circMv) / 10000, 1) : null,
        confTurnover: t1.turnoverRate ?? null,
      };

      for (const f of FACTORS) {
        const label = f.assign(fv);
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

function selfTest(): void {
  const fv = { hitCount: 3, maxShadow: 2.3, sectorVolRatioT: 0.8, circMvYi: 25, confTurnover: 4 };
  for (const f of FACTORS) console.log(f.name, '=>', f.assign(fv));
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) { selfTest(); return; }

  const latestRow = await prisma.dailyBar.findFirst({ orderBy: { tradeDate: 'desc' }, select: { tradeDate: true } });
  if (!latestRow) throw new Error('no daily bars');
  const latestDate = latestRow.tradeDate;

  const t0 = Date.now();
  const conceptsOf = await loadConceptMembers();
  const conceptHits = await loadConceptHits();
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

  const total = acc['hitCount'] ? Object.values(acc['hitCount']).reduce((a, c) => a + c.n, 0) : 0;
  console.log('\n=== 打分因子梯度（2024-2026，剔924，当前门槛，主口径 T+1 冲高胜率）===');
  console.log('total signals =', total);
  for (const f of FACTORS) {
    console.log('\n## ' + f.name);
    for (const b of f.buckets) console.log('  ' + b.padEnd(10), JSON.stringify(cellOut(acc[f.name][b])));
  }

  console.log('\ntotal elapsed', Date.now() - t0, 'ms');
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
