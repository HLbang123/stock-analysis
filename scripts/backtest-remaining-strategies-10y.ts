import { prisma } from '../lib/db';

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
  adjFactor: number | null;
  name: string | null;
}

interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnoverRate: number | null;
}

function round(n: number, d = 2): number {
  const p = Math.pow(10, d);
  return Math.round(n * p) / p;
}
function fmtDate(d: string): string {
  return d.length === 8 ? d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8) : d;
}
function median(arr: number[]): number {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 === 0 ? (a[mid - 1] + a[mid]) / 2 : a[mid];
}
function stats(arr: number[]) {
  const n = arr.length;
  const avg = n ? arr.reduce((a, b) => a + b, 0) / n : 0;
  const win = n ? arr.filter((x) => x > 0).length / n : 0;
  return { n, avg: round(avg), winRate: round(win * 100), median: round(median(arr)) };
}

function prevClose(bars: Bar[], i: number): number {
  return i > 0 ? bars[i - 1].close : bars[i].open;
}
function isLimitUp(b: Bar, prev: number): boolean {
  const limit = round(prev * 1.10);
  return Math.abs(b.close - limit) <= 0.01 && b.high >= limit - 0.01;
}
function isOneWord(b: Bar, prev: number): boolean {
  const limit = round(prev * 1.10);
  return b.open >= limit - 0.01 && (b.high - b.low) <= limit * 0.0015;
}

function threeYinReturns(bars: Bar[], idx: number) {
  if (idx < 3 || idx + 1 >= bars.length) return null;
  const b0 = bars[idx - 3], b1 = bars[idx - 2], b2 = bars[idx - 1], b3 = bars[idx], next = bars[idx + 1];
  const limit = round(prevClose(bars, idx - 3) * 1.10);
  if (!isLimitUp(b0, prevClose(bars, idx - 3))) return null;
  if (isOneWord(b0, prevClose(bars, idx - 3))) return null;
  if (!(b1.open > b0.close && b1.high > b0.high)) return null;
  const yins = [b1, b2, b3];
  for (let k = 0; k < yins.length; k++) {
    const y = yins[k];
    const prev = k === 0 ? b0.close : yins[k - 1].close;
    const body = ((y.open - y.close) / y.open) * 100;
    if (!(y.close < y.open && body >= 0.05 && body <= 3.0)) return null;
    if (!(y.close < prev)) return null;
  }
  if (!(b0.volume > b1.volume && b1.volume > b2.volume && b2.volume > b3.volume)) return null;
  const entry = b3.close;
  return {
    date: b3.date,
    entry,
    retOpen: round(((next.open - entry) / entry) * 100),
    retHigh: round(((next.high - entry) / entry) * 100),
  };
}

function doubleDragonBoard(bars: Bar[], idx: number) {
  if (idx < 1 || idx + 1 >= bars.length) return null;
  const b0 = bars[idx - 1], b1 = bars[idx], next = bars[idx + 1];
  const prev0 = prevClose(bars, idx - 1);
  if (!isLimitUp(b0, prev0)) return null;
  if (isOneWord(b0, prev0)) return null;
  const body = ((b0.close - b0.open) / prev0) * 100;
  if (body < 5) return null;
  const lookback = Math.max(0, idx - 1 - 60);
  let maxHigh = 0;
  for (let i = lookback; i < idx - 1; i++) maxHigh = Math.max(maxHigh, bars[i].high);
  if (b0.close <= maxHigh) return null;
  const volWindow = bars.slice(Math.max(0, idx - 1 - 5), idx - 1);
  const avgVol = volWindow.length ? volWindow.reduce((a, b) => a + b.volume, 0) / volWindow.length : 0;
  if (avgVol > 0 && b0.volume < avgVol * 1.5) return null;
  const prev1 = prevClose(bars, idx);
  if (!isLimitUp(b1, prev1)) return null;
  const entry = round(prev1 * 1.10);
  return {
    date: b1.date,
    entry,
    retOpen: round(((next.open - entry) / entry) * 100),
    retHigh: round(((next.high - entry) / entry) * 100),
  };
}

// 【2026-09-11 已删除】ma5 + doubleDragonPullback（双龙回踩，十年实测负 alpha，已从策略体系移除）

async function loadBars(marginStart: string, endDate: string): Promise<RawBar[]> {
  const sql = [
    'SELECT b."tsCode", b."tradeDate", b.open, b.high, b.low, b.close,',
    '       b.pre_close AS "preClose", b.vol, b.turnover_rate AS "turnoverRate",',
    '       b.adj_factor AS "adjFactor"',
    'FROM daily_bars b',
    'JOIN stocks s ON s.ts_code = b."tsCode"',
    'WHERE b."tradeDate" > $1 AND b."tradeDate" <= $2',
    "  AND s.is_active = true",
    "  AND s.ts_code ~ '^(600|601|603|605|000|001|002|003)'",
    "  AND s.name !~ '(ST|退)'",
  ].join('\n');
  return prisma.$queryRawUnsafe<RawBar[]>(sql, marginStart, endDate);
}

async function main() {
  const years = 10;
  const chunkDays = 250;
  const marginDays = 10;
  const approxDates = years * 250 + marginDays;

  const latest = await prisma.dailyBar.findFirst({ orderBy: { tradeDate: 'desc' }, select: { tradeDate: true } });
  if (!latest) throw new Error('no daily bars');
  const latestDate = latest.tradeDate;

  const dateRows = await prisma.$queryRawUnsafe<{ d: string }[]>(
    'SELECT DISTINCT "tradeDate" AS d FROM daily_bars WHERE "tradeDate" <= $1 ORDER BY "tradeDate" DESC LIMIT $2',
    latestDate,
    approxDates
  );
  const datesAsc = dateRows.map((r) => r.d).reverse();
  if (datesAsc.length <= marginDays) throw new Error('not enough trade dates');

  const syRows: { date: string; retOpen: number; retHigh: number }[] = [];
  const ddBoardRows: { date: string; retOpen: number; retHigh: number }[] = [];
  const t0 = Date.now();

  for (let start = marginDays; start < datesAsc.length; start += chunkDays) {
    const endIdx = Math.min(start + chunkDays - 1, datesAsc.length - 1);
    const exclusiveLower = datesAsc[start - 1];
    const windowEnd = datesAsc[endIdx];
    const nextDate = datesAsc[Math.min(endIdx + 1, datesAsc.length - 1)];
    const marginStart = datesAsc[start - marginDays];
    const raw = await loadBars(marginStart, nextDate);

    const rawByCode = new Map<string, RawBar[]>();
    for (const r of raw) {
      if (r.open == null || r.close == null || r.high == null || r.low == null) continue;
      if (!rawByCode.has(r.tsCode)) rawByCode.set(r.tsCode, []);
      rawByCode.get(r.tsCode)!.push(r);
    }

    for (const rawBars of rawByCode.values()) {
      rawBars.sort((a, b) => (a.tradeDate < b.tradeDate ? -1 : 1));
      const latestAdj = rawBars[rawBars.length - 1]?.adjFactor ?? 1;
      const factor = latestAdj > 0 ? latestAdj : 1;
      const bars: Bar[] = rawBars.map((r) => {
        const adj = r.adjFactor ?? 1;
        const f = factor > 0 ? adj / factor : 1;
        return {
          date: fmtDate(r.tradeDate),
          open: Number(r.open) * f,
          high: Number(r.high) * f,
          low: Number(r.low) * f,
          close: Number(r.close) * f,
          volume: Number(r.vol ?? 0),
          turnoverRate: r.turnoverRate != null ? Number(r.turnoverRate) : null,
        };
      });

      for (let i = 0; i < bars.length; i++) {
        if (bars[i].date <= fmtDate(exclusiveLower)) continue;
        const sy = threeYinReturns(bars, i);
        if (sy) syRows.push(sy);
        const db = doubleDragonBoard(bars, i);
        if (db) ddBoardRows.push(db);
      }
    }
    console.log('chunk done', fmtDate(exclusiveLower), '->', fmtDate(windowEnd), 'sy', syRows.length, 'ddBoard', ddBoardRows.length, 'elapsed', Date.now() - t0);
  }

  const summary = {
    threeYin: {
      n: syRows.length,
      retOpen: stats(syRows.map((r) => r.retOpen)),
      retHigh: stats(syRows.map((r) => r.retHigh)),
    },
    doubleDragonBoard: {
      n: ddBoardRows.length,
      retOpen: stats(ddBoardRows.map((r) => r.retOpen)),
      retHigh: stats(ddBoardRows.map((r) => r.retHigh)),
    },
  };
  console.log(JSON.stringify(summary, null, 2));
  console.log('total elapsed', Date.now() - t0, 'ms');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
