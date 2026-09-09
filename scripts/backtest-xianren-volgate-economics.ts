/**
 * 仙人指路 — 「确认日缩量」硬门槛的经济学账（冲高口径 + 可实现收益口径）
 *
 * 问题：该门槛把信号量砍到 ~42%，换来 T+1 冲高胜率 +2.3pp。值不值？
 * 只看胜率会误导（去掉低质量样本胜率必升，但可能同时去掉大涨样本）。
 * 本脚本对同一批信号按 confVolRatio 切成两组，比较：
 *   n / 每日均机会数 / 胜率 / 均值 / 中位 / 尾部(p10,p25)
 *   口径① 冲高（T+1 当日最高、T+5 累计最高）—— 理想口径，原主指标
 *   口径② 可实现（T+1 收盘卖、T+5 收盘卖）—— 真实能拿到的收益
 * 并做两比例 z 检验，判断 +2.3pp 是噪声还是真信号。
 *
 * 数据：2022~2026 五年，剔 924，主板非 ST，固定基线 = 生产 DEFAULT_XIANREN_CONFIG。
 */

import { prisma } from '../lib/db';
import { detectXianRenAt, DEFAULT_XIANREN_CONFIG, XianRenBar } from '../lib/strategy/xian-ren-zhi-lu';

interface RawBar {
  tsCode: string; tradeDate: string;
  open: number | null; high: number | null; low: number | null; close: number | null;
  preClose: number | null; vol: number | null; turnoverRate: number | null; circMv: number | null; name: string | null;
}

const YEARS = ['2022', '2023', '2024', '2025', '2026'];
const EXCLUDE_LO = '2024-09-24';
const EXCLUDE_HI = '2024-10-08';

const round = (n: number, d = 3): number => { const p = Math.pow(10, d); return Math.round(n * p) / p; };
const fmtDate = (d: string): string => (d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d);

interface Row {
  cv: number;          // confVolRatio（缺失记 0 并置 cvNull）
  cvNull: boolean;     // confVolRatio 是否缺失（前5日量不足等）
  rT1high: number;     // T+1（次日）当日最高
  rT1close: number;    // T+1（次日）收盘
  rT5cum: number;      // T+2..T+6 累计最高
  rT5close: number;    // T+5 收盘
  date: string;
}

function loadBars(start: string, end: string): Promise<RawBar[]> {
  const sql = [
    'SELECT b."tsCode" AS "tsCode", b."tradeDate" AS "tradeDate",',
    '       b.open, b.high, b.low, b.close, b.pre_close AS "preClose", b.vol,',
    '       b.turnover_rate AS "turnoverRate", b.circ_mv AS "circMv"',
    'FROM daily_bars b',
    'JOIN stocks s ON s.ts_code = b."tsCode"',
    'WHERE b."tradeDate" >= $1 AND b."tradeDate" <= $2',
    '  AND s.is_active = true',
    "  AND s.ts_code ~ '^(600|601|603|605|000|001|002|003)'",
    "  AND s.name !~ '(ST|退)'",
  ].join('\n');
  return prisma.$queryRawUnsafe<RawBar[]>(sql, start, end);
}

function processRaw(raw: RawBar[], year: string, rows: Row[]): void {
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
      open: r.open as number, high: r.high as number, low: r.low as number, close: r.close as number,
      volume: Number(r.vol ?? 0),
      preClose: r.preClose != null ? Number(r.preClose) : null,
      turnoverRate: r.turnoverRate != null ? Number(r.turnoverRate) : null,
    }));
    for (let i = 61; i < bars.length; i++) {
      const t0 = bars[i - 1], t1 = bars[i];
      const upperShadow = t0.high - Math.max(t0.open, t0.close);
      if ((upperShadow / t0.open) * 100 < 1.5) continue;
      if ((upperShadow > 0 ? ((t1.close - t0.close) / upperShadow) * 100 : 0) < 40) continue;
      const confClosePos = t1.high > t1.low ? (t1.close - t1.low) / (t1.high - t1.low) : 0.5;
      if (confClosePos < 0.7) continue;
      if (((t1.open - t0.close) / t0.close) * 100 > 1.0) continue;

      // 关键：必须显式关掉「确认日缩量」门槛，否则拿到的「全部」其实是已过门槛的集合，
      // 分组就退化成恒等切分（这正是第一版脚本的错误）。
      const sig = detectXianRenAt(bars, i, { ...DEFAULT_XIANREN_CONFIG, confVolRatioMax: 999 });
      if (!sig.matched) continue;
      if (sig.entryDate.slice(0, 4) !== year) continue;
      if (sig.entryDate >= EXCLUDE_LO && sig.entryDate <= EXCLUDE_HI) continue;
      const entry = sig.entryPrice;
      if (!entry || entry <= 0) continue;
      const b1 = bars[i + 1];
      if (!b1) continue;
      let cumHigh = -Infinity, ok = true;
      for (let n = 1; n <= 5; n++) { const b = bars[i + n]; if (!b) { ok = false; break; } if (b.high > cumHigh) cumHigh = b.high; }
      if (!ok) continue;
      const b5 = bars[i + 5];
      if (!b5) continue;
      rows.push({
        cv: sig.metrics.confVolRatio ?? 0,
        cvNull: sig.metrics.confVolRatio == null,
        rT1high: ((b1.high - entry) / entry) * 100,
        rT1close: ((b1.close - entry) / entry) * 100,
        rT5cum: ((cumHigh - entry) / entry) * 100,
        rT5close: ((b5.close - entry) / entry) * 100,
        date: sig.entryDate,
      });
    }
  }
}

function q(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(a.length * p))];
}

const METRICS: [string, (r: Row) => number][] = [
  ['T+1冲高(次日最高)', (r) => r.rT1high],
  ['T+1收盘卖', (r) => r.rT1close],
  ['T+5累计最高', (r) => r.rT5cum],
  ['T+5收盘卖', (r) => r.rT5close],
];

function report(name: string, rows: Row[], days: number): void {
  const n = rows.length;
  console.log(`\n## ${name}   n=${n}  日均可交易=${round(n / days, 2)} 只/日`);
  for (const [k, sel] of METRICS) {
    const arr = rows.map(sel);
    const mean = round(arr.reduce((a, b) => a + b, 0) / (arr.length || 1), 2);
    const win = round((arr.filter((x) => x > 0).length / (arr.length || 1)) * 100, 2);
    console.log(
      `   ${k.padEnd(18)} 胜率=${String(win).padStart(6)}%  均值=${String(mean).padStart(6)}%  中位=${String(round(q(arr, 0.5), 2)).padStart(6)}%  p25=${String(round(q(arr, 0.25), 2)).padStart(7)}%  p10=${String(round(q(arr, 0.1), 2)).padStart(7)}%`
    );
  }
}

async function main(): Promise<void> {
  const latestRow = await prisma.dailyBar.findFirst({ orderBy: { tradeDate: 'desc' }, select: { tradeDate: true } });
  const latest = latestRow?.tradeDate ?? '20260909';
  const rows: Row[] = [];
  for (const year of YEARS) {
    const loadStart = `${Number(year) - 1}0701`;
    const rawEnd = `${Number(year) + 1}0110`;
    const loadEnd = rawEnd < latest ? rawEnd : latest;
    const raw = await loadBars(loadStart, loadEnd);
    processRaw(raw, year, rows);
    console.log(`[chunk] ${year} window ${loadStart}~${loadEnd} rows=${raw.length} signals=${rows.length}`);
  }
  const dayRows: any[] = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS c FROM review_calendar_days WHERE trade_date >= '20220101' AND trade_date <= $1`,
    latest
  );
  const days = Number(dayRows[0]?.c ?? 1250);
  console.log(`[meta] 交易日=${days} 总信号=${rows.length}`);

  const cvNull = rows.filter((r) => r.cvNull);
  const known = rows.filter((r) => !r.cvNull);
  const cvLow = known.filter((r) => r.cv < 1.0);
  const cvHigh = known.filter((r) => r.cv >= 1.0);
  report('全部信号（显式关掉缩量门槛）', rows, days);
  report('缩量组 confVolRatio<1.0（当前硬门槛保留的）', cvLow, days);
  report('非缩量组 confVolRatio>=1.0（当前被门槛砍掉的）', cvHigh, days);
  console.log(`\n[meta] confVolRatio 缺失（无法判定）=${cvNull.length} 条，已排除出分组`);

  const ztest = (a: Row[], b: Row[], sel: (r: Row) => number) => {
    const wa = a.filter((r) => sel(r) > 0).length, wb = b.filter((r) => sel(r) > 0).length;
    const p1 = wa / (a.length || 1), p2 = wb / (b.length || 1);
    const p = (wa + wb) / ((a.length + b.length) || 1);
    const se = Math.sqrt(p * (1 - p) * (1 / (a.length || 1) + 1 / (b.length || 1)));
    return { diff: round((p1 - p2) * 100, 2), z: se > 0 ? round((p1 - p2) / se, 2) : 0 };
  };
  const z1 = ztest(cvLow, cvHigh, (r) => r.rT1high);
  const z2 = ztest(cvLow, cvHigh, (r) => r.rT1close);
  console.log(`\n## 显著性（缩量组 vs 非缩量组，两比例 z 检验）`);
  console.log(`   T+1冲高胜率差 = ${z1.diff}pp  z=${z1.z}  ${Math.abs(z1.z) >= 1.96 ? '显著(p<0.05)' : '不显著'}`);
  console.log(`   T+1收盘卖胜率差 = ${z2.diff}pp  z=${z2.z}  ${Math.abs(z2.z) >= 1.96 ? '显著(p<0.05)' : '不显著'}`);

  const mean = (a: Row[], sel: (r: Row) => number) => a.reduce((s, r) => s + sel(r), 0) / (a.length || 1);
  console.log(`\n## 每日总期望（日均可交易数 × 单次均值）`);
  console.log(`   T+1收盘卖  全部=${round((rows.length / days) * mean(rows, (r) => r.rT1close), 3)} %/日   仅缩量=${round((cvLow.length / days) * mean(cvLow, (r) => r.rT1close), 3)} %/日`);
  console.log(`   T+1冲高    全部=${round((rows.length / days) * mean(rows, (r) => r.rT1high), 3)} %/日   仅缩量=${round((cvLow.length / days) * mean(cvLow, (r) => r.rT1high), 3)} %/日`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
