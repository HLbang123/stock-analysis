import { prisma } from '../lib/db';
import {
  scanDragonFirstYinSignals,
  DragonBar,
  DragonFirstYinConfig,
} from '../lib/strategy/dragon-first-yin';

/**
 * 龙首阴 10 年日线回测（分块流式，控制内存）
 *
 * 口径同 backtest-dragon-first-yin.ts：
 *   - 主板 3~5 连板后首阴；假阴真阳优先；连续一字板降级；
 *   - 量比 ≤ 前5日均量3倍、首阴换手 ≤45%；
 *   - 入口1：首阴收盘价；入口2：次日打板价；收益统一看次日最高点；
 *   - 额外统计：次日开盘收益（更贴近可成交口径）。
 *
 * 用法：npx tsx scripts/backtest-dragon-first-yin-10y.ts --years 10 --chunk 250
 * 服务器长跑请用 setsid + NODE_OPTIONS=--max-old-space-size=3584。
 */

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

interface Row {
  code: string;
  name: string;
  date: string;
  boardCount: number;
  quality: string;
  yinType: string;
  priority: string;
  retOpen: number;
  retCloseHigh: number;
  retBoardHigh: number | null;
}

function round(n: number, digits = 2): number {
  const p = Math.pow(10, digits);
  return Math.round(n * p) / p;
}

function fmtDate(d: string): string {
  return d.length === 8 ? d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8) : d;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
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

function dist(arr: number[]) {
  const n = arr.length;
  const pct = (x: number) => (n ? round((x / n) * 100) : 0);
  return {
    n,
    le0: { n: arr.filter((x) => x <= 0).length, pct: pct(arr.filter((x) => x <= 0).length) },
    gt0le2: { n: arr.filter((x) => x > 0 && x <= 2).length, pct: pct(arr.filter((x) => x > 0 && x <= 2).length) },
    gt2le5: { n: arr.filter((x) => x > 2 && x <= 5).length, pct: pct(arr.filter((x) => x > 2 && x <= 5).length) },
    gt5le8: { n: arr.filter((x) => x > 5 && x <= 8).length, pct: pct(arr.filter((x) => x > 5 && x <= 8).length) },
    gt8: { n: arr.filter((x) => x > 8).length, pct: pct(arr.filter((x) => x > 8).length) },
  };
}

function groupStats(rows: (Row & { label: string })[]) {
  const out: Record<string, { closeHigh: number[]; boardHigh: number[] }> = {};
  for (const r of rows) {
    (out[r.label] ??= { closeHigh: [], boardHigh: [] });
    out[r.label].closeHigh.push(r.retCloseHigh);
    if (r.retBoardHigh != null) out[r.label].boardHigh.push(r.retBoardHigh);
  }
  return Object.fromEntries(Object.entries(out).map(([label, v]) => [
    label,
    {
      n: v.closeHigh.length,
      closeHigh: stats(v.closeHigh),
      boardHigh: stats(v.boardHigh),
    },
  ]));
}

async function loadBars(marginStart: string, endDate: string): Promise<RawBar[]> {
  const sql = [
    'SELECT b."tsCode", b."tradeDate", b.open, b.high, b.low, b.close,',
    '       b.pre_close AS "preClose", b.vol, b.turnover_rate AS "turnoverRate",',
    '       b.adj_factor AS "adjFactor", s.name',
    'FROM daily_bars b',
    'JOIN stocks s ON s.ts_code = b."tsCode"',
    'WHERE b."tradeDate" > $1 AND b."tradeDate" <= $2',
    "  AND s.is_active = true",
    "  AND s.ts_code ~ '^(600|601|603|605|000|001|002|003)'",
    "  AND s.name !~ '(ST|退)'",
    'ORDER BY b."tsCode", b."tradeDate"',
  ].join('\n');
  return prisma.$queryRawUnsafe<RawBar[]>(sql, marginStart, endDate);
}

function processRaw(raw: RawBar[], exclusiveLowerDate: string): Row[] {
  const rawByCode = new Map<string, RawBar[]>();
  const nameOf = new Map<string, string>();
  for (const r of raw) {
    if (r.open == null || r.close == null || r.high == null || r.low == null) continue;
    nameOf.set(r.tsCode, r.name ?? '');
    if (!rawByCode.has(r.tsCode)) rawByCode.set(r.tsCode, []);
    rawByCode.get(r.tsCode)!.push(r);
  }

  const rows: Row[] = [];
  const cfg: Partial<DragonFirstYinConfig> = {};
  for (const [code, rawBars] of rawByCode) {
    rawBars.sort((a, b) => (a.tradeDate < b.tradeDate ? -1 : 1));
    const latestAdj = rawBars[rawBars.length - 1]?.adjFactor ?? 1;
    const factor = latestAdj > 0 ? latestAdj : 1;
    const bars: DragonBar[] = rawBars.map((r) => {
      const adj = r.adjFactor ?? 1;
      const f = factor > 0 ? adj / factor : 1;
      return {
        date: fmtDate(r.tradeDate),
        open: Number(r.open) * f,
        high: Number(r.high) * f,
        low: Number(r.low) * f,
        close: Number(r.close) * f,
        volume: Number(r.vol ?? 0),
        preClose: null,
        turnoverRate: r.turnoverRate != null ? Number(r.turnoverRate) : null,
      };
    });

    const signals = scanDragonFirstYinSignals(bars, cfg);
    for (const sig of signals) {
      if (!sig.yin || !sig.run) continue;
      if (sig.yin.date <= fmtDate(exclusiveLowerDate)) continue;
      const next = bars[sig.yin.index + 1];
      if (!next) continue;
      const entryClose = sig.yin.close;
      const nextHigh = next.high;
      const nextOpen = next.open;
      const retOpen = round(((nextOpen - entryClose) / entryClose) * 100);
      const retCloseHigh = round(((nextHigh - entryClose) / entryClose) * 100);
      const nextPre = next.preClose ?? sig.yin.close;
      const nextLimit = round(nextPre * 1.10);
      let retBoardHigh: number | null = null;
      if (next.high >= nextLimit - 0.01) {
        retBoardHigh = round(((nextHigh - nextLimit) / nextLimit) * 100);
      }
      rows.push({
        code,
        name: nameOf.get(code) ?? '',
        date: sig.yin.date,
        boardCount: sig.run.boardCount,
        quality: sig.run.quality,
        yinType: sig.yin.fakeYin ? 'fake' : 'real',
        priority: sig.priority,
        retOpen,
        retCloseHigh,
        retBoardHigh,
      });
    }
  }
  return rows;
}

async function main() {
  const arg = (key: string) => {
    const i = process.argv.indexOf(key);
    return i >= 0 ? Number(process.argv[i + 1]) : NaN;
  };
  const years = Number.isFinite(arg('--years')) ? Math.min(Math.max(arg('--years'), 1), 10) : 10;
  const chunkDays = Number.isFinite(arg('--chunk')) ? Math.min(Math.max(arg('--chunk'), 60), 250) : 250;
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

  const allRows: Row[] = [];
  const t0 = Date.now();
  let chunkIdx = 0;
  for (let start = marginDays; start < datesAsc.length; start += chunkDays, chunkIdx += 1) {
    const endIdx = Math.min(start + chunkDays - 1, datesAsc.length - 1);
    const exclusiveLower = datesAsc[start - 1];
    const windowEnd = datesAsc[endIdx];
    const nextDate = datesAsc[Math.min(endIdx + 1, datesAsc.length - 1)];
    const marginStart = datesAsc[start - marginDays];
    const raw = await loadBars(marginStart, nextDate);
    const rows = processRaw(raw, exclusiveLower);
    allRows.push(...rows);
    console.log('chunk', chunkIdx, 'window', exclusiveLower, '->', windowEnd, 'loaded', raw.length, 'signals', rows.length, 'elapsed', Date.now() - t0, 'ms');
  }

  const three = allRows.filter((r) => r.boardCount === 3);
  const byYear: Record<string, any> = {};
  const yearsSeen = [...new Set(allRows.map((r) => r.date.slice(0, 4)))].sort();
  for (const y of yearsSeen) {
    byYear[y] = {
      n: allRows.filter((r) => r.date.slice(0, 4) === y).length,
      closeHigh: stats(allRows.filter((r) => r.date.slice(0, 4) === y).map((r) => r.retCloseHigh)),
      threeCloseHigh: stats(allRows.filter((r) => r.date.slice(0, 4) === y && r.boardCount === 3).map((r) => r.retCloseHigh)),
    };
  }

  const summary = {
    dateRange: fmtDate(datesAsc[marginDays]) + ' -> ' + fmtDate(latestDate),
    total: allRows.length,
    closeHigh: stats(allRows.map((r) => r.retCloseHigh)),
    open: stats(allRows.map((r) => r.retOpen)),
    boardFillable: stats(allRows.filter((r) => r.retBoardHigh != null).map((r) => r.retBoardHigh!)),
    byBoard: groupStats(allRows.map((r) => ({ ...r, label: String(r.boardCount) + '板' }))),
    byYinType: groupStats(allRows.map((r) => ({ ...r, label: r.yinType === 'fake' ? '假阴真阳' : '真阴' }))),
    byQuality: groupStats(allRows.map((r) => ({ ...r, label: r.quality === 'turnover' ? '换手板' : r.quality === 'oneWord' ? '一字板' : '混合板' }))),
    byPriority: groupStats(allRows.map((r) => ({ ...r, label: r.priority }))),
    byYear,
    dist3Board: {
      open: stats(three.map((r) => r.retOpen)),
      openDist: dist(three.map((r) => r.retOpen)),
      high: stats(three.map((r) => r.retCloseHigh)),
      highDist: dist(three.map((r) => r.retCloseHigh)),
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
