import { prisma } from '../lib/db';
import {
  scanDragonFirstYinSignals,
  isMainBoardNonST,
  DragonBar,
  DragonFirstYinSignal,
  DragonFirstYinConfig,
} from '../lib/strategy/dragon-first-yin';

/**
 * 龙首阴日线回测（小窗版，服务器一次性脚本）
 *
 * 口径（2026-08-27 确认）：
 *   - 主板 3~5 连板后首阴；假阴真阳优先，真阴保留；连续一字板降级；
 *   - 量比 ≤ 前5日均量3倍、首阴换手 ≤45%；
 *   - 入口1：首阴收盘价买入；入口2：次日打板价买入（需次日最高价能摸到涨停价）；
 *   - 收益：统一统计次日最高点相对买入价。
 *
 * 用法：npx tsx scripts/backtest-dragon-first-yin.ts --days 30
 * 只查窗口内日线，外加 10 个交易日的连板上下文余量，适合服务器小窗试跑。
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

function groupStats(rows: { retCloseHigh: number; retBoardHigh: number | null; label: string }[]) {
  const out: Record<string, any> = {};
  for (const r of rows) {
    (out[r.label] ??= { closeHigh: [], boardHigh: [] });
    out[r.label].closeHigh.push(r.retCloseHigh);
    if (r.retBoardHigh != null) out[r.label].boardHigh.push(r.retBoardHigh);
  }
  return Object.fromEntries(Object.entries(out).map(([label, v]: [string, any]) => [
    label,
    {
      n: v.closeHigh.length,
      closeHigh: stats(v.closeHigh),
      boardHigh: stats(v.boardHigh),
    },
  ]));
}

async function main() {
  const arg = (key: string) => {
    const i = process.argv.indexOf(key);
    return i >= 0 ? Number(process.argv[i + 1]) : NaN;
  };
  const days = Number.isFinite(arg('--days')) ? Math.min(Math.max(arg('--days'), 10), 250) : 30;

  const latest = await prisma.dailyBar.findFirst({ orderBy: { tradeDate: 'desc' }, select: { tradeDate: true } });
  if (!latest) throw new Error('no daily bars');
  const latestDate = latest.tradeDate;

  // 窗口起点：从最新交易日往前 days 个交易日（窗口内共 days 根）
  const windowStartRows = await prisma.$queryRawUnsafe<{ d: string }[]>(
    'SELECT DISTINCT "tradeDate" AS d FROM daily_bars WHERE "tradeDate" <= $1 ORDER BY "tradeDate" DESC LIMIT 1 OFFSET $2',
    latestDate,
    days
  );
  const windowStart = windowStartRows[0]?.d;
  if (!windowStart) throw new Error('window start not found');

  // 余量起点：窗口起再往前 10 个交易日，保证窗口边缘的首阴能数全 3~5 板
  const marginRows = await prisma.$queryRawUnsafe<{ d: string }[]>(
    'SELECT DISTINCT "tradeDate" AS d FROM daily_bars WHERE "tradeDate" <= $1 ORDER BY "tradeDate" DESC LIMIT 1 OFFSET $2',
    windowStart,
    10
  );
  const marginStart = marginRows[0]?.d ?? windowStart;

  const t0 = Date.now();
  const raw: RawBar[] = await prisma.$queryRawUnsafe<RawBar[]>(
    `SELECT b."tsCode", b."tradeDate", b.open, b.high, b.low, b.close,
            b.pre_close AS "preClose", b.vol, b.turnover_rate AS "turnoverRate", b.adj_factor AS "adjFactor", s.name
     FROM daily_bars b
     JOIN stocks s ON s.ts_code = b."tsCode"
     WHERE b."tradeDate" > $1 AND b."tradeDate" <= $2
       AND s.is_active = true
       AND s.ts_code ~ '^(600|601|603|605|000|001|002|003)'
       AND s.name !~ '(ST|退)'
     ORDER BY b."tsCode", b."tradeDate"`,
    marginStart,
    latestDate
  );
  console.log('loaded rows:', raw.length, 'in', Date.now() - t0, 'ms');

  const rawByCode = new Map<string, RawBar[]>();
  const nameOf = new Map<string, string>();
  for (const r of raw) {
    if (r.open == null || r.close == null || r.high == null || r.low == null) continue;
    nameOf.set(r.tsCode, r.name ?? '');
    if (!rawByCode.has(r.tsCode)) rawByCode.set(r.tsCode, []);
    rawByCode.get(r.tsCode)!.push(r);
  }

  // 前复权归一：raw OHLC 未复权，除权日会出现假跳空；统一归一到每票窗口内最新 adj_factor
  const byCode = new Map<string, DragonBar[]>();
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
        preClose: null, // 统一用前一根调整后收盘价，避免未复权 pre_close 混入口径
        turnoverRate: r.turnoverRate != null ? Number(r.turnoverRate) : null,
      };
    });
    byCode.set(code, bars);
  }

  const cfg: Partial<DragonFirstYinConfig> = {};
  const rows: {
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
  }[] = [];

  for (const [code, bars] of byCode) {
    bars.sort((a, b) => (a.date < b.date ? -1 : 1));
    const signals = scanDragonFirstYinSignals(bars, cfg);
    for (const sig of signals) {
      if (!sig.yin || !sig.run) continue;
      if (sig.yin.date <= fmtDate(windowStart)) continue; // 只统计窗口内首阴
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

  console.log('signals in window:', rows.length);
  console.log('date range:', fmtDate(windowStart), '->', fmtDate(latestDate));

  const three = rows.filter((r) => r.boardCount === 3);
  const summary = {
    total: rows.length,
    closeHigh: stats(rows.map((r) => r.retCloseHigh)),
    boardFillable: stats(rows.filter((r) => r.retBoardHigh != null).map((r) => r.retBoardHigh!)),
    byBoard: groupStats(rows.map((r) => ({ ...r, label: String(r.boardCount) + '板' }))),
    byYinType: groupStats(rows.map((r) => ({ ...r, label: r.yinType === 'fake' ? '假阴真阳' : '真阴' }))),
    byQuality: groupStats(rows.map((r) => ({ ...r, label: r.quality === 'turnover' ? '换手板' : r.quality === 'oneWord' ? '一字板' : '混合板' }))),
    byPriority: groupStats(rows.map((r) => ({ ...r, label: r.priority }))),
    dist3Board: {
      open: stats(three.map((r) => r.retOpen)),
      openDist: dist(three.map((r) => r.retOpen)),
      high: stats(three.map((r) => r.retCloseHigh)),
      highDist: dist(three.map((r) => r.retCloseHigh)),
    },
  };

  console.log(JSON.stringify(summary, null, 2));
  console.log('sample rows (latest 20):');
  console.log(JSON.stringify(rows.slice(-20).reverse(), null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
