/**
 * 仙人指路 — 确认日门槛敏感性（confClosePos / confOpenGap，冲高口径，剔 924，2024~2026）
 *
 * 待办 3（docs/short-term-rule-refine-handoff.md）：
 *   确认日侧两个门槛：confClosePosMin（确认日收盘位下限）、
 *   confOpenGapMax（确认日高开上限%）。上一轮敏感性未覆盖，本轮补。
 *
 * ⚠️ 2026-09-11 已按本脚本 + 另一轮更细的实测结论放宽（见 lib/strategy/xian-ren-zhi-lu.ts 的 DEFAULT）：
 *   confClosePosMin 0.7 → 0.5（本脚本显示 0.5~0.9 各档 T+1均 2.06~2.15、T+5≥2% 67.1~67.7，几乎无区分度）、
 *   confOpenGapMax 1.0 → 5.0（放宽后 +9% 信号且各项略好）。**本文档里的「当前 x」注释已过期，勿再引用。**
 *
 * 本轮口径（与用户确认，2026-09-09）：
 *   - 目标：优先提高胜率，只有胜率「明显提升」才考虑收紧（降样本量）。
 *   - 固定基线：volRatioMin=0、核心门槛 1.5/40（待办2结论：不改），其余用 DEFAULT_XIANREN_CONFIG。
 *   - 样本：2024 / 2025 / 2026 三年，剔除 924（信号日 2024-09-24 ~ 2024-10-08）。
 *   - 收益口径 = 冲高：T+1 当日最高 + T+5 累计最高（胜率 >0、均值），外加 T+5 冲高>2% 概率。
 *   - 扫描：
 *       1) confClosePosMin ∈ {0.5,0.6,0.7,0.8,0.9}（另一门 confOpenGap 固定 <=1.0）
 *       2) confOpenGapMax ∈ {0,0.5,1.0,1.5,2.0,3.0}（另一门 confClosePos 固定 >=0.7）
 *   - 性能：O(1) 前置闸门（raw 上影>=1.5% & 反包>=40% & 收盘位>=0.5 & 高开<=3%）
 *     过滤后再进完整 detectXianRenAt；只跑一次最松配置 (0.5, 3.0)，raw 分桶。
 *
 * 用法：
 *   npx tsx scripts/backtest-xianren-confirm-sensitivity.ts --selftest
 *   npx tsx scripts/backtest-xianren-confirm-sensitivity.ts
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

const YEARS = ['2024', '2025', '2026'];
const EXCLUDE_LO = '2024-09-24';
const EXCLUDE_HI = '2024-10-08';

const POS_THRESHOLDS = [0.5, 0.6, 0.7, 0.8, 0.9];
const GAP_THRESHOLDS = [0, 0.5, 1.0, 1.5, 2.0, 3.0];

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

function cellSummary(c: CellAcc): Record<string, unknown> {
  return {
    n: c.t1.length,
    t1: stats(c.t1),
    t5cum: stats(c.t5cum),
    t5gt2Pct: gt2Pct(c.t5cum),
  };
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

interface Acc {
  pos: Record<string, CellAcc>;
  gap: Record<string, CellAcc>;
  posByYear: Record<string, Record<string, CellAcc>>;
  gapByYear: Record<string, Record<string, CellAcc>>;
}

function emptyAccs(): Acc {
  const pos: Record<string, CellAcc> = {};
  const gap: Record<string, CellAcc> = {};
  for (const p of POS_THRESHOLDS) pos[String(p)] = { t1: [], t5cum: [] };
  for (const g of GAP_THRESHOLDS) gap[String(g)] = { t1: [], t5cum: [] };
  return { pos, gap, posByYear: {}, gapByYear: {} };
}

function push(
  cell: CellAcc,
  retT1: number,
  retT5Cum: number,
  byYear: Record<string, CellAcc>,
  year: string
): void {
  cell.t1.push(retT1);
  cell.t5cum.push(retT5Cum);
  let y = byYear[year];
  if (!y) { y = { t1: [], t5cum: [] }; byYear[year] = y; }
  y.t1.push(retT1);
  y.t5cum.push(retT5Cum);
}

function processRaw(raw: RawBar[], year: string, acc: Acc): void {
  const byCode = new Map<string, RawBar[]>();
  for (const r of raw) {
    if (r.open == null || r.close == null || r.high == null || r.low == null) continue;
    if (!byCode.has(r.tsCode)) byCode.set(r.tsCode, []);
    byCode.get(r.tsCode)!.push(r);
  }

  const relaxedCfg = { ...DEFAULT_XIANREN_CONFIG, confClosePosMin: 0.5, confOpenGapMax: 3.0 };
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
      const t0 = bars[i - 1];
      const t1 = bars[i];

      // O(1) 前置闸门（最松配置的严格超集，先挡掉绝大多数 K 线）
      const upperShadow = t0.high - Math.max(t0.open, t0.close);
      const upperShadowPct = (upperShadow / t0.open) * 100;
      if (upperShadowPct < 1.5) continue;
      const confPctPct = upperShadow > 0 ? ((t1.close - t0.close) / upperShadow) * 100 : 0;
      if (confPctPct < 40) continue;
      const confClosePos = t1.high > t1.low ? (t1.close - t1.low) / (t1.high - t1.low) : 0.5;
      if (confClosePos < 0.5) continue;
      const confOpenGap = ((t1.open - t0.close) / t0.close) * 100;
      if (confOpenGap > 3.0) continue;

      const sig = detectXianRenAt(bars, i, relaxedCfg);
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

      // confClosePos 扫描（固定 confOpenGap <= 1.0）
      if (confOpenGap <= 1.0) {
        for (const p of POS_THRESHOLDS) {
          if (confClosePos >= p) {
            push(acc.pos[String(p)], retT1, retT5Cum, acc.posByYear[String(p)] ??= {}, year);
          }
        }
      }
      // confOpenGap 扫描（固定 confClosePos >= 0.7）
      if (confClosePos >= 0.7) {
        for (const g of GAP_THRESHOLDS) {
          if (confOpenGap <= g) {
            push(acc.gap[String(g)], retT1, retT5Cum, acc.gapByYear[String(g)] ??= {}, year);
          }
        }
      }
    }
  }
}

function selfTest(): void {
  // 复用合成形态，只验证 raw confClosePos / confOpenGap 计算
  const prev = 10;
  const t0 = { open: prev, high: prev * 1.04, low: prev * 0.999, close: prev * 1.001 };
  const t1 = { open: prev * 1.005, high: prev * 1.03, low: prev * 1.001, close: prev * 1.025 };
  const confClosePos = t1.high > t1.low ? (t1.close - t1.low) / (t1.high - t1.low) : 0.5;
  const confOpenGap = ((t1.open - t0.close) / t0.close) * 100;
  console.log('selftest confClosePos =', round(confClosePos, 3), 'confOpenGap =', round(confOpenGap, 3));
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

  const acc = emptyAccs();
  const t0 = Date.now();
  for (const year of YEARS) {
    const loadStart = `${Number(year) - 1}0901`;
    const loadEndRaw = `${Number(year) + 1}0110`;
    const loadEnd = loadEndRaw < latestDate ? loadEndRaw : latestDate;
    const raw = await loadBars(loadStart, loadEnd);
    processRaw(raw, year, acc);
    console.log('year', year, 'window', loadStart, '->', loadEnd, 'loaded', raw.length, 'elapsed', Date.now() - t0, 'ms');
  }

  console.log('\n=== confClosePos 敏感性（固定 confOpenGap<=1.0，剔924，2024-2026）===');
  console.log(JSON.stringify(
    Object.fromEntries(POS_THRESHOLDS.map((p) => [String(p), cellSummary(acc.pos[String(p)])])),
    null, 2
  ));

  console.log('\n=== confOpenGap 敏感性（固定 confClosePos>=0.7，剔924，2024-2026）===');
  console.log(JSON.stringify(
    Object.fromEntries(GAP_THRESHOLDS.map((g) => [String(g), cellSummary(acc.gap[String(g)])])),
    null, 2
  ));

  console.log('\n=== confClosePos 逐年 ===');
  const posYearly: Record<string, unknown> = {};
  for (const p of POS_THRESHOLDS) {
    const by = acc.posByYear[String(p)] ?? {};
    posYearly[String(p)] = Object.fromEntries(YEARS.map((y) => {
      const c = by[y];
      return [y, c ? {
        n: c.t1.length,
        t1WinRate: stats(c.t1).winRate,
        t5cumWinRate: stats(c.t5cum).winRate,
        t5gt2Pct: gt2Pct(c.t5cum),
      } : { n: 0 }];
    }));
  }
  console.log(JSON.stringify(posYearly, null, 2));

  console.log('\n=== confOpenGap 逐年 ===');
  const gapYearly: Record<string, unknown> = {};
  for (const g of GAP_THRESHOLDS) {
    const by = acc.gapByYear[String(g)] ?? {};
    gapYearly[String(g)] = Object.fromEntries(YEARS.map((y) => {
      const c = by[y];
      return [y, c ? {
        n: c.t1.length,
        t1WinRate: stats(c.t1).winRate,
        t5cumWinRate: stats(c.t5cum).winRate,
        t5gt2Pct: gt2Pct(c.t5cum),
      } : { n: 0 }];
    }));
  }
  console.log(JSON.stringify(gapYearly, null, 2));

  console.log('\ntotal elapsed', Date.now() - t0, 'ms');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
