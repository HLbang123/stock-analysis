/**
 * 仙人指路 — 核心定义门槛网格扫描（冲高口径，剔 924，2024~2026）
 *
 * 待办 2（docs/short-term-rule-refine-handoff.md）：
 *   核心门槛 upperShadowPctMin（试盘日上影幅度下限）× confPctMin（确认日反包上影比例下限）
 *   做网格扫描。当前生产值 = 1.5 / 40。
 *
 * 本轮口径（与用户确认，2026-09-09）：
 *   - 目标：优先提高胜率（样本已足够大）。
 *   - 网格：upperShadowPctMin ∈ {1.2, 1.5, 2.0} × confPctMin ∈ {30, 40, 50, 60}。
 *   - 固定基线：volRatioMin = 0（已落地），其余门槛用 DEFAULT_XIANREN_CONFIG。
 *   - 样本：2024 / 2025 / 2026 三年，剔除 924（信号日 2024-09-24 ~ 2024-10-08）。
 *   - 收益口径 = 冲高：T+1 当日最高 + T+5 累计最高（胜率 >0、均值），外加 T+5 冲高>2% 概率。
 *   - 实现：只跑一次最松配置 (1.2, 30)，再按 raw upperShadowPct / confPct 分桶到 12 格，
 *     避免跑 12 遍全量。raw 值直接从 bars 重算，规避 metrics 四舍五入边界误差。
 *
 * 用法：
 *   npx tsx scripts/backtest-xianren-core-grid.ts --selftest   # 纯逻辑自检，不连库
 *   npx tsx scripts/backtest-xianren-core-grid.ts              # 全量 3 年
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
  name: string | null;
}

const SHADOW_THRESHOLDS = [1.2, 1.5, 2.0];
const CONF_THRESHOLDS = [30, 40, 50, 60]; // 百分比

const YEARS = ['2024', '2025', '2026'];
const EXCLUDE_LO = '2024-09-24';
const EXCLUDE_HI = '2024-10-08';

const round = (n: number, d = 2): number => {
  const p = Math.pow(10, d);
  return Math.round(n * p) / p;
};

const fmtDate = (d: string): string =>
  d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d;

const cellKey = (u: number, c: number): string => `u${u}|c${c}`;

interface CellAcc {
  t1: number[];     // T+1 当日最高收益 %
  t5cum: number[];  // T+5 累计最高收益 %
}

function makeCells(): Map<string, CellAcc> {
  const m = new Map<string, CellAcc>();
  for (const u of SHADOW_THRESHOLDS) {
    for (const c of CONF_THRESHOLDS) {
      m.set(cellKey(u, c), { t1: [], t5cum: [] });
    }
  }
  return m;
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

/**
 * 扫描单年：返回两个聚合（整体 + 逐年）。
 * 只跑一次最松配置，raw 分桶到 12 格。
 */
function processRaw(
  raw: RawBar[],
  year: string,
  cells: Map<string, CellAcc>,
  cellsByYear: Map<string, Map<string, CellAcc>>
): void {
  const byCode = new Map<string, RawBar[]>();
  for (const r of raw) {
    if (r.open == null || r.close == null || r.high == null || r.low == null) continue;
    if (!byCode.has(r.tsCode)) byCode.set(r.tsCode, []);
    byCode.get(r.tsCode)!.push(r);
  }

  const relaxedCfg = { ...DEFAULT_XIANREN_CONFIG, upperShadowPctMin: 1.2, confPctMin: 0.3 };
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
    }));

    for (let i = 1; i < bars.length; i++) {
      const sig = detectXianRenAt(bars, i, relaxedCfg);
      if (!sig.matched) continue;
      if (sig.entryDate.slice(0, 4) !== year) continue;
      if (sig.entryDate >= EXCLUDE_LO && sig.entryDate <= EXCLUDE_HI) continue;

      const entry = sig.entryPrice;
      if (!entry || entry <= 0) continue;

      // 前视收益：T+1 当日最高 + T+5 累计最高
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

      // raw 分桶（与 detectXianRenAt 同公式，规避 metrics 四舍五入）
      const t0 = bars[i - 1];
      const t1 = bars[i];
      const upperShadow = t0.high - Math.max(t0.open, t0.close);
      const upperShadowPct = (upperShadow / t0.open) * 100;
      const confPctPct = upperShadow > 0 ? ((t1.close - t0.close) / upperShadow) * 100 : 0;

      for (const u of SHADOW_THRESHOLDS) {
        if (upperShadowPct < u) continue;
        for (const c of CONF_THRESHOLDS) {
          if (confPctPct < c) continue;
          const k = cellKey(u, c);
          cells.get(k)!.t1.push(retT1);
          cells.get(k)!.t5cum.push(retT5Cum);
          let ym = cellsByYear.get(k);
          if (!ym) { ym = new Map<string, CellAcc>(); cellsByYear.set(k, ym); }
          let yc = ym.get(year);
          if (!yc) { yc = { t1: [], t5cum: [] }; ym.set(year, yc); }
          yc.t1.push(retT1);
          yc.t5cum.push(retT5Cum);
        }
      }
    }
  }
}

function cellSummary(c: CellAcc): Record<string, unknown> {
  return {
    n: c.t1.length,
    t1: stats(c.t1),
    t5cum: stats(c.t5cum),
    t5gt2Pct: gt2Pct(c.t5cum),
  };
}

function printMatrix(cells: Map<string, CellAcc>): void {
  const header = '            ' + SHADOW_THRESHOLDS.map((u) => ` 上影>=${u}% `.padStart(0)).join('');
  console.log(header);
  console.log('            ' + SHADOW_THRESHOLDS.map(() => '-----------------').join(''));
  for (const c of CONF_THRESHOLDS) {
    let line = `反包>=${String(c).padStart(2)}%  `;
    for (const u of SHADOW_THRESHOLDS) {
      const acc = cells.get(cellKey(u, c))!;
      const s1 = stats(acc.t1);
      const s5 = stats(acc.t5cum);
      const g2 = gt2Pct(acc.t5cum);
      line += ` n=${String(acc.t1.length).padStart(4)} T1win=${String(s1.winRate).padStart(5)}% T5win=${String(s5.winRate).padStart(5)}% T5>2=${String(g2).padStart(5)}%`;
    }
    console.log(line);
  }
}

function selfTest(): void {
  // 合成一段能命中最松配置 (1.2, 30) 的形态，验证 raw 分桶与收益计算
  const bars: XianRenBar[] = [];
  for (let i = 0; i < 61; i++) {
    const base = 10 + i * 0.01;
    bars.push({
      date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
      open: base,
      high: base * 1.004,
      low: base * 0.996,
      close: base,
      volume: 100000,
      preClose: base * 0.999,
    });
  }
  const prev = bars[60].close;
  bars.push({
    date: '2026-03-02', open: prev, high: prev * 1.04, low: prev * 0.999,
    close: prev * 1.001, volume: 250000, preClose: prev,
  });
  bars.push({
    date: '2026-03-03', open: prev * 1.005, high: prev * 1.03, low: prev * 1.001,
    close: prev * 1.025, volume: 120000, preClose: prev * 1.001,
  });
  for (let n = 1; n <= 5; n++) {
    const last = bars[bars.length - 1].close;
    bars.push({
      date: `2026-03-${String(3 + n).padStart(2, '0')}`,
      open: last * 1.001, high: last * (1 + 0.01 * n), low: last * 0.999,
      close: last * 1.002, volume: 100000, preClose: last,
    });
  }
  const sig = detectXianRenAt(bars, 62, { ...DEFAULT_XIANREN_CONFIG, upperShadowPctMin: 1.2, confPctMin: 0.3 });
  const t0 = bars[61];
  const t1 = bars[62];
  const upperShadow = t0.high - Math.max(t0.open, t0.close);
  const upperShadowPct = (upperShadow / t0.open) * 100;
  const confPctPct = upperShadow > 0 ? ((t1.close - t0.close) / upperShadow) * 100 : 0;
  console.log('selftest matched =', sig.matched, 'upperShadowPct =', round(upperShadowPct), 'confPctPct =', round(confPctPct));
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

  const cells = makeCells();
  const cellsByYear = new Map<string, Map<string, CellAcc>>();
  const t0 = Date.now();

  for (const year of YEARS) {
    const loadStart = `${Number(year) - 1}0901`;
    const loadEndRaw = `${Number(year) + 1}0110`;
    const loadEnd = loadEndRaw < latestDate ? loadEndRaw : latestDate;
    const raw = await loadBars(loadStart, loadEnd);
    processRaw(raw, year, cells, cellsByYear);
    console.log('year', year, 'window', loadStart, '->', loadEnd, 'loaded', raw.length, 'elapsed', Date.now() - t0, 'ms');
  }

  console.log('\n=== 12 格矩阵（剔924，2024-2026）===');
  printMatrix(cells);

  console.log('\n=== 12 格明细 ===');
  const detail: Record<string, unknown> = {};
  for (const u of SHADOW_THRESHOLDS) {
    for (const c of CONF_THRESHOLDS) {
      const k = cellKey(u, c);
      detail[k] = cellSummary(cells.get(k)!);
    }
  }
  console.log(JSON.stringify(detail, null, 2));

  console.log('\n=== 逐年（每格）===');
  const yearly: Record<string, unknown> = {};
  for (const u of SHADOW_THRESHOLDS) {
    for (const c of CONF_THRESHOLDS) {
      const k = cellKey(u, c);
      const ym = cellsByYear.get(k);
      const entry: Record<string, unknown> = {};
      for (const y of YEARS) {
        const yc = ym?.get(y);
        entry[y] = yc ? {
          n: yc.t1.length,
          t1WinRate: stats(yc.t1).winRate,
          t5cumWinRate: stats(yc.t5cum).winRate,
          t5gt2Pct: gt2Pct(yc.t5cum),
        } : { n: 0 };
      }
      yearly[k] = entry;
    }
  }
  console.log(JSON.stringify(yearly, null, 2));

  console.log('\ntotal elapsed', Date.now() - t0, 'ms');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
