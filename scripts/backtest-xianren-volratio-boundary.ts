/**
 * 仙人指路 — volRatioMin 0.8 vs 0 边界回测（冲高口径，剔 924）
 *
 * 待办 1（docs/short-term-rule-refine-handoff.md）：
 *   当前落地 volRatioMin=0.8（放宽，非删除）。本脚本测「完全删除」（volRatioMin=0）
 *   是否会引入极端缩量的垃圾信号。
 *
 * 口径（docs/sector-xianren-backtest-spec.md 统一口径）：
 *   - 样本：主板非ST，2020~2026 共 7 年，按年分块加载，前取 margin 自前一年 09-01。
 *   - 剔除 924 行情：信号日（T1 确认日）落在 2024-09-24 ~ 2024-10-08 的样本全部剔除。
 *   - 收益口径 = 冲高，不是收盘：
 *       组1 当日最高 = (bars[i+N].high - entry)/entry，N=1..5，输出胜率(>0) + 均值；
 *       组2 累计最高 = (max(bars[i+1..i+N].high) - entry)/entry，N=1..5，输出胜率(>0) + 均值。
 *   - entry = T1（确认日）收盘价。
 *   - 信号检测复用生产代码 detectXianRenAt，只用一个 volRatioMin=0 变体跑一次，
 *     再按 metrics.volRatio >= 0.8 拆分 baseline / added，避免跑两遍。
 *
 * 用法：
 *   npx tsx scripts/backtest-xianren-volratio-boundary.ts --year 2026   # 小窗（只跑一年）
 *   npx tsx scripts/backtest-xianren-volratio-boundary.ts                # 全量 7 年
 *   npx tsx scripts/backtest-xianren-volratio-boundary.ts --selftest     # 纯逻辑自检，不连库
 *
 * 服务器长跑：
 *   NODE_OPTIONS=--max-old-space-size=2048 setsid nohup npx tsx scripts/backtest-xianren-volratio-boundary.ts > /tmp/xianren-volratio.log 2>&1 &
 */

import { prisma } from '../lib/db';
import { detectXianRenAt, DEFAULT_XIANREN_CONFIG, XianRenBar } from '../lib/strategy/xian-ren-zhi-lu';

/** 股票名称按码预加载（铁律 2：不在 SQL 里每行带出变长字符串 s.name，省约 19% 传输） */
const stockNames = new Map<string, string>();
async function loadStockNames(): Promise<void> {
  if (stockNames.size > 0) return;
  const rows: { tsCode: string; name: string }[] = await prisma.$queryRawUnsafe(
    'SELECT ts_code AS "tsCode", name FROM stocks'
  );
  for (const r of rows) stockNames.set(r.tsCode, r.name);
}

interface RawBar {
  tsCode: string;
  tradeDate: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  preClose: number | null;
  vol: number | null;
}

interface SignalRow {
  code: string;
  name: string;
  date: string; // T1 确认日 YYYY-MM-DD
  volRatio: number;
  retDailyHigh: (number | null)[]; // N=1..5
  retCumHigh: (number | null)[];   // N=1..5
}

const round = (n: number, digits = 2): number => {
  const p = Math.pow(10, digits);
  return Math.round(n * p) / p;
};

const fmtDate = (d: string): string =>
  d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d;

const inRange = (d: string, lo: string, hi: string): boolean => d >= lo && d <= hi;

/** 924 行情剔除窗口（信号日 = T1 确认日） */
const EXCLUDE_LO = '2024-09-24';
const EXCLUDE_HI = '2024-10-08';

function stats(arr: number[]): { n: number; avg: number; winRate: number } {
  const n = arr.length;
  const avg = n ? arr.reduce((a, b) => a + b, 0) / n : 0;
  const win = n ? arr.filter((x) => x > 0).length / n : 0;
  return { n, avg: round(avg), winRate: round(win * 100) };
}

/** 一组信号的 T+1 / T+5 主口径（组1 当日最高 + 组2 累计最高） */
function groupSummary(rows: SignalRow[]): Record<string, unknown> {
  const dailyN = (n: number) => rows.map((r) => r.retDailyHigh[n - 1]).filter((x): x is number => x != null);
  const cumN = (n: number) => rows.map((r) => r.retCumHigh[n - 1]).filter((x): x is number => x != null);
  const out: Record<string, unknown> = { n: rows.length };
  for (const n of [1, 2, 3, 4, 5]) {
    out[`t${n}DailyHigh`] = stats(dailyN(n));
    out[`t${n}CumHigh`] = stats(cumN(n));
  }
  return out;
}

function loadBars(start: string, end: string): Promise<RawBar[]> {
  const sql = [
    'SELECT b."tsCode" AS "tsCode", b."tradeDate" AS "tradeDate",',
    '       b.open, b.high, b.low, b.close, b.pre_close AS "preClose", b.vol',
    'FROM daily_bars b',
    'JOIN stocks s ON s.ts_code = b."tsCode"',
    'WHERE b."tradeDate" >= $1 AND b."tradeDate" <= $2',
    "  AND s.is_active = true",
    "  AND s.ts_code ~ '^(600|601|603|605|000|001|002|003)'",
    "  AND s.name !~ '(ST|退)'",
  ].join('\n');
  return prisma.$queryRawUnsafe<RawBar[]>(sql, start, end);
}

function processRaw(raw: RawBar[], year: string): SignalRow[] {
  const byCode = new Map<string, RawBar[]>();
  const nameOf = stockNames;
  for (const r of raw) {
    if (r.open == null || r.close == null || r.high == null || r.low == null) continue;
    if (!byCode.has(r.tsCode)) byCode.set(r.tsCode, []);
    byCode.get(r.tsCode)!.push(r);
  }

  const out: SignalRow[] = [];
  for (const [code, rawBars] of byCode) {
    rawBars.sort((a, b) => (a.tradeDate < b.tradeDate ? -1 : 1));
    const bars: XianRenBar[] = rawBars.map((r) => ({
      date: fmtDate(r.tradeDate),
      open: r.open as number,
      high: r.high as number,
      low: r.low as number,
      close: r.close as number,
      volume: Number(r.vol ?? 0),
      preClose: r.preClose != null ? Number(r.preClose) : null,
    }));

    // 只跑一个 volRatioMin=0 变体，再按 volRatio 拆 0.8 baseline / 0 variant
    const cfg = { ...DEFAULT_XIANREN_CONFIG, volRatioMin: 0 };
    for (let i = 1; i < bars.length; i++) {
      const sig = detectXianRenAt(bars, i, cfg);
      if (!sig.matched) continue;
      // 信号归属：T1 落在目标年份；剔除 924
      if (sig.entryDate.slice(0, 4) !== year) continue;
      if (inRange(sig.entryDate, EXCLUDE_LO, EXCLUDE_HI)) continue;

      const entry = sig.entryPrice;
      if (!entry || entry <= 0) continue;
      const retDailyHigh: (number | null)[] = [];
      const retCumHigh: (number | null)[] = [];
      let cumHigh = -Infinity;
      let ok = true;
      for (let n = 1; n <= 5; n++) {
        const b = bars[i + n];
        if (!b) {
          ok = false;
          break;
        }
        if (b.high > cumHigh) cumHigh = b.high;
        retDailyHigh.push(round(((b.high - entry) / entry) * 100));
        retCumHigh.push(round(((cumHigh - entry) / entry) * 100));
      }
      // 至少要有 T+1；T+1..T+5 不足的保留到有 bar 的为止
      if (!ok && retDailyHigh.length === 0) continue;

      out.push({
        code,
        name: nameOf.get(code) ?? '',
        date: sig.entryDate,
        volRatio: sig.metrics.volRatio ?? 0,
        retDailyHigh,
        retCumHigh,
      });
    }
  }
  return out;
}

function printGroup(label: string, rows: SignalRow[]): void {
  const s = groupSummary(rows);
  console.log(`\n=== ${label} (n=${s.n}) ===`);
  console.log(JSON.stringify(s, null, 2));
}

function selfTest(): void {
  // 造一段合成 K 线：前 61 根平稳，T0 长上影，T1 反包，后面 5 根给冲高
  const bars: XianRenBar[] = [];
  const base = 10;
  for (let i = 0; i < 61; i++) {
    const c = base + i * 0.01;
    bars.push({
      date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
      open: c,
      high: c * 1.005,
      low: c * 0.995,
      close: c,
      volume: 100000,
      preClose: c * 0.999,
    });
  }
  const t0 = 61;
  const t1 = 62;
  const prev = bars[t0 - 1].close;
  bars.push({
    date: '2026-03-02',
    open: prev,
    high: prev * 1.045, // 上影 4.4%，振幅 4.6%（<=5%），实体极小
    low: prev * 0.999,
    close: prev * 1.001,
    volume: 250000, // 放量（量比>1）
    preClose: prev,
  });
  bars.push({
    date: '2026-03-03',
    open: prev * 1.005,
    high: prev * 1.04,
    low: prev * 1.001,
    close: prev * 1.035, // 反包
    volume: 120000,
    preClose: prev * 1.001,
  });
  for (let n = 1; n <= 5; n++) {
    const last = bars[bars.length - 1].close;
    bars.push({
      date: `2026-03-${String(3 + n).padStart(2, '0')}`,
      open: last * 1.001,
      high: last * (1 + 0.01 * n),
      low: last * 0.999,
      close: last * 1.002,
      volume: 100000,
      preClose: last,
    });
  }

  const cfg = { ...DEFAULT_XIANREN_CONFIG, volRatioMin: 0 };
  const sig = detectXianRenAt(bars, t1, cfg);
  console.log('selftest matched =', sig.matched, 'volRatio =', sig.metrics.volRatio, 'confPct =', sig.metrics.confPct);
  const entry = sig.entryPrice;
  const r = [1, 2, 3, 4, 5].map((n) => ({
    n,
    daily: round(((bars[t1 + n].high - entry) / entry) * 100),
    cum: round(((Math.max(...bars.slice(t1 + 1, t1 + n + 1).map((b) => b.high)) - entry) / entry) * 100),
  }));
  console.log(JSON.stringify({ entry, returns: r }, null, 2));
}

async function main() {
  await loadStockNames();
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) {
    selfTest();
    return;
  }

  const yearArg = args.includes('--year') ? args[args.indexOf('--year') + 1] : undefined;
  const years = yearArg
    ? [yearArg]
    : ['2020', '2021', '2022', '2023', '2024', '2025', '2026'];

  const latestRow = await prisma.dailyBar.findFirst({
    orderBy: { tradeDate: 'desc' },
    select: { tradeDate: true },
  });
  if (!latestRow) throw new Error('no daily bars');
  const latestDate = latestRow.tradeDate;

  const all: SignalRow[] = [];
  const t0 = Date.now();
  for (const year of years) {
    const loadStart = `${Number(year) - 1}0901`;
    const loadEndRaw = `${Number(year) + 1}0110`;
    const loadEnd = loadEndRaw < latestDate ? loadEndRaw : latestDate;
    const raw = await loadBars(loadStart, loadEnd);
    const rows = processRaw(raw, year);
    all.push(...rows);
    console.log(
      'year', year, 'window', loadStart, '->', loadEnd,
      'loaded', raw.length, 'signals', rows.length,
      'elapsed', Date.now() - t0, 'ms'
    );
  }

  const baseline = all.filter((r) => r.volRatio >= 0.8);
  const added = all.filter((r) => r.volRatio < 0.8);

  printGroup('variant volRatioMin=0（全部信号）', all);
  printGroup('baseline volRatioMin=0.8（volRatio>=0.8）', baseline);
  printGroup('新增（volRatio<0.8，仅 0 引入）', added);

  // 新增信号按 volRatio 分桶，看「极端缩量」是否垃圾
  const buckets: { label: string; lo: number; hi: number; rows: SignalRow[] }[] = [
    { label: 'volRatio<0.3', lo: -Infinity, hi: 0.3, rows: [] },
    { label: 'volRatio[0.3,0.5)', lo: 0.3, hi: 0.5, rows: [] },
    { label: 'volRatio[0.5,0.8)', lo: 0.5, hi: 0.8, rows: [] },
  ];
  for (const r of added) {
    const b = buckets.find((x) => r.volRatio >= x.lo && r.volRatio < x.hi);
    b?.rows.push(r);
  }
  for (const b of buckets) printGroup(`新增·${b.label}`, b.rows);

  // 逐年：baseline / variant / added 的 T+1 冲高胜率+均值，T+5 累计
  const yearsSeen = [...new Set(all.map((r) => r.date.slice(0, 4)))].sort();
  const yearly: Record<string, unknown> = {};
  for (const y of yearsSeen) {
    const baseY = baseline.filter((r) => r.date.slice(0, 4) === y);
    const allY = all.filter((r) => r.date.slice(0, 4) === y);
    const addedY = added.filter((r) => r.date.slice(0, 4) === y);
    const d1 = (rows: SignalRow[]) => stats(rows.map((r) => r.retDailyHigh[0]).filter((x): x is number => x != null));
    const c5 = (rows: SignalRow[]) => stats(rows.map((r) => r.retCumHigh[4]).filter((x): x is number => x != null));
    yearly[y] = {
      baseline: { n: baseY.length, t1DailyHigh: d1(baseY), t5CumHigh: c5(baseY) },
      variant: { n: allY.length, t1DailyHigh: d1(allY), t5CumHigh: c5(allY) },
      added: { n: addedY.length, t1DailyHigh: d1(addedY), t5CumHigh: c5(addedY) },
    };
  }
  console.log('\n=== 逐年（剔924）===');
  console.log(JSON.stringify(yearly, null, 2));

  console.log('\ntotal elapsed', Date.now() - t0, 'ms');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
