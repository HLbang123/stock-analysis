/**
 * 仙人指路 — 新增维度梯度扫描（趋势 / 位置新口径 / T0量能 / 上影结构）
 *
 * 背景：现有因子清单（backtest-xianren-factor-scan.ts 的 17 因子）没有覆盖「趋势类」维度，
 *   而界内 74% 样本 hitCount=0（无板块共振）挤在底部，缺共振外的区分因子。
 *   本脚本在**当前生产信号池**上，对以下新维度做梯度：
 *
 *   趋势类（全新）
 *     maAlign    5>10>20 多头排列 + 价在 5 日线上
 *     ma60Slope  60 日均线斜率（相对 5 日前）
 *     ma60Pos    收盘相对 60 日均线的位置
 *     macd       DIF/DEA 相对位置 + DIF 零轴上下（金叉/死叉四象限）
 *   位置类（换口径）
 *     pctFrom60Low    距 60 日最低价涨幅（旧口径 gain60 = 相对 60 日前收盘）
 *     ddFrom60High    距 60 日最高价回撤
 *   量能/结构（新口径）
 *     t0Turnover      试盘日换手率（旧清单只测过确认日换手）
 *     shadowOfAmp     上影 / 当日振幅
 *     vetoCombo       量比>5 且 换手>10%（问财的一票否决）
 *   参考项（已覆盖，用于复核外部说法）
 *     shadowRatio     上影/实体比（外部称 ≥3 倍最优）
 *     upperShadowPct  上影绝对幅度（外部称 ≥5% 最优）
 *
 * 口径：主板非 ST、原始价；信号 = 生产 DEFAULT_XIANREN_CONFIG（含确认日缩量 ≤1.0）；
 *   2022~2026，剔 924；主指标 T+1 冲高胜率 + T+5 累计胜率；每个因子附逐年稳定性。
 *
 * 用法：
 *   npx tsx scripts/backtest-xianren-newdim-gradient.ts --selftest
 *   npx tsx scripts/backtest-xianren-newdim-gradient.ts --years=2024
 *   npx tsx scripts/backtest-xianren-newdim-gradient.ts            # 2022~2026
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
  name: string | null;
}

interface Bar {
  date: string;
  open: number; high: number; low: number; close: number;
  volume: number;
  preClose: number | null;
  turnoverRate: number | null;
}

const YEARS = ['2022', '2023', '2024', '2025', '2026'];
const EX_LO = '2024-09-24';
const EX_HI = '2024-10-08';

const round = (n: number, d = 2): number => {
  const p = Math.pow(10, d);
  return Math.round(n * p) / p;
};
const fmtDate = (d: string): string =>
  d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d;

function loadBars(start: string, end: string): Promise<RawBar[]> {
  const sql = [
    'SELECT b."tsCode" AS "tsCode", b."tradeDate" AS "tradeDate",',
    '       b.open, b.high, b.low, b.close, b.pre_close AS "preClose", b.vol,',
    '       b.turnover_rate AS "turnoverRate"',
    'FROM daily_bars b',
    'JOIN stocks s ON s.ts_code = b."tsCode"',
    'WHERE b."tradeDate" >= $1 AND b."tradeDate" <= $2',
    '  AND s.is_active = true',
    "  AND s.ts_code ~ '^(600|601|603|605|000|001|002|003)'",
    "  AND s.name !~ '(ST|退)'",
  ].join('\n');
  return prisma.$queryRawUnsafe<RawBar[]>(sql, start, end);
}

/** 一条样本：前向收益 + 全部新维度取值 */
interface Sample {
  year: string;
  date: string;
  rT1: number;   // T+1 当日最高
  rT5: number;   // T+5 累计最高
  f: Record<string, string>;
}

function b(v: number | null | undefined, edges: number[], labels: string[]): string {
  if (v == null || !Number.isFinite(v)) return 'N/A';
  for (let i = 0; i < edges.length; i++) if (v < edges[i]) return labels[i];
  return labels[labels.length - 1];
}

/** EMA 序列（用于 MACD） */
function ema(values: number[], period: number): number[] {
  const out: number[] = [];
  const k = 2 / (period + 1);
  let prev = values[0] ?? 0;
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

interface Acc { rows: Sample[] }

function processRaw(raw: RawBar[], year: string, acc: Acc): void {
  const byCode = new Map<string, RawBar[]>();
  for (const r of raw) {
    if (r.open == null || r.close == null || r.high == null || r.low == null) continue;
    if (!byCode.has(r.tsCode)) byCode.set(r.tsCode, []);
    byCode.get(r.tsCode)!.push(r);
  }

  for (const rawBars of byCode.values()) {
    rawBars.sort((a, b2) => (a.tradeDate < b2.tradeDate ? -1 : 1));
    const bars: Bar[] = rawBars.map((r) => ({
      date: fmtDate(r.tradeDate),
      open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close),
      volume: Number(r.vol ?? 0),
      preClose: r.preClose != null ? Number(r.preClose) : null,
      turnoverRate: r.turnoverRate != null ? Number(r.turnoverRate) : null,
    }));
    if (bars.length < 130) continue;

    const closes = bars.map((x) => x.close);
    const e12 = ema(closes, 12);
    const e26 = ema(closes, 26);
    const dif = closes.map((_, i) => e12[i] - e26[i]);
    const dea = ema(dif, 9);

    const ma = (i: number, n: number): number | null => {
      if (i < n - 1) return null;
      let s = 0;
      for (let j = i - n + 1; j <= i; j++) s += closes[j];
      return s / n;
    };

    for (let i = 65; i < bars.length; i++) {
      if (bars[i].date.slice(0, 4) !== year) continue;
      // 先做 O(1) 前置闸门（与 detect 内部一致的最小条件），避免全量调用
      const t0 = bars[i - 1], t1 = bars[i];
      const upperShadow = t0.high - Math.max(t0.open, t0.close);
      if (!(upperShadow / t0.open * 100 >= 1.5)) continue;
      if (!(upperShadow > 0 && ((t1.close - t0.close) / upperShadow) * 100 >= 40)) continue;
      if (!(t1.high > t1.low ? (t1.close - t1.low) / (t1.high - t1.low) >= 0.7 : true)) continue;
      if (!(((t1.open - t0.close) / t0.close) * 100 <= 1.0)) continue;

      const sig = detectXianRenAt(bars as XianRenBar[], i, DEFAULT_XIANREN_CONFIG);
      if (!sig.matched) continue;
      if (sig.entryDate >= EX_LO && sig.entryDate <= EX_HI) continue;
      const entry = sig.entryPrice;
      if (!(entry > 0)) continue;

      const b1 = bars[i + 1];
      if (!b1) continue;
      let cum = -Infinity, ok = true;
      for (let n = 1; n <= 5; n++) {
        const bb = bars[i + n];
        if (!bb) { ok = false; break; }
        if (bb.high > cum) cum = bb.high;
      }
      if (!ok) continue;

      const t0Idx = i - 1;
      const m5 = ma(t0Idx, 5), m10 = ma(t0Idx, 10), m20 = ma(t0Idx, 20), m60 = ma(t0Idx, 60);
      const m60prev = ma(t0Idx - 5, 60);
      const ma60Slope = m60 != null && m60prev != null && m60prev > 0 ? ((m60 - m60prev) / m60prev) * 100 : null;

      let low60 = Infinity, high60 = -Infinity;
      for (let j = Math.max(0, t0Idx - 59); j <= t0Idx; j++) {
        if (bars[j].low < low60) low60 = bars[j].low;
        if (bars[j].high > high60) high60 = bars[j].high;
      }
      const pctFrom60Low = low60 > 0 && Number.isFinite(low60) ? ((t0.close - low60) / low60) * 100 : null;
      const ddFrom60High = high60 > 0 && Number.isFinite(high60) ? ((t0.close - high60) / high60) * 100 : null;

      const amp = t0.high - t0.low;
      const shadowOfAmp = amp > 0 ? (upperShadow / amp) * 100 : null;
      const bodyAbs = Math.abs(t0.close - t0.open);
      const shadowRatio = bodyAbs > 0.01 ? upperShadow / bodyAbs : (upperShadow > 0 ? 999 : 0);
      const volRatio = sig.metrics.volRatio ?? null;
      const t0Turnover = t0.turnoverRate;

      let maAlign = '非多头(混/空头)';
      if (m5 != null && m10 != null && m20 != null) {
        if (m5 > m10 && m10 > m20) maAlign = t0.close > m5 ? '多头&价>MA5' : '多头但价<MA5';
      }
      let macdQ = 'N/A';
      if (Number.isFinite(dif[t0Idx]) && Number.isFinite(dea[t0Idx])) {
        const d = dif[t0Idx], e = dea[t0Idx];
        macdQ = d > 0 ? (d > e ? 'DIF>0&金叉' : 'DIF>0&死叉') : (d > e ? 'DIF<0&金叉' : 'DIF<0&死叉');
      }

      acc.rows.push({
        year,
        date: sig.entryDate,
        rT1: round(((b1.high - entry) / entry) * 100),
        rT5: round(((cum - entry) / entry) * 100),
        f: {
          maAlign,
          ma60Slope: b(ma60Slope, [-1, 0, 1], ['<-1%', '-1~0%', '0~1%', '>1%']),
          ma60Pos: m60 != null ? (t0.close > m60 ? '价在MA60上' : '价在MA60下') : 'N/A',
          macd: macdQ,
          pctFrom60Low: b(pctFrom60Low, [10, 20, 30], ['0-10%', '10-20%', '20-30%', '>30%']),
          ddFrom60High: b(ddFrom60High, [-30, -15, -5], ['<=-30%', '-30~-15%', '-15~-5%', '>-5%']),
          t0Turnover: b(t0Turnover, [3, 5, 10, 15], ['<3', '3-5', '5-10', '10-15', '>=15']),
          shadowOfAmp: b(shadowOfAmp, [40, 60, 80], ['<40%', '40-60%', '60-80%', '>=80%']),
          vetoCombo: volRatio != null && t0Turnover != null && volRatio > 5 && t0Turnover > 10 ? '是' : '否',
          shadowRatio: b(shadowRatio, [2, 3, 5], ['1.2-2', '2-3', '3-5', '>=5']),
          upperShadowPct: b(sig.metrics.upperShadowPct, [2, 3, 5], ['1.5-2%', '2-3%', '3-5%', '>=5%']),
        },
      });
    }
  }
}

const FACTORS: { name: string; order: string[]; note: string }[] = [
  { name: 'maAlign', order: ['多头&价>MA5', '多头但价<MA5', '非多头(混/空头)'], note: '趋势：5>10>20 多头排列 + 价在 5 日线上' },
  { name: 'ma60Slope', order: ['<-1%', '-1~0%', '0~1%', '>1%'], note: '趋势：60 日均线斜率（相对 5 日前）' },
  { name: 'ma60Pos', order: ['价在MA60上', '价在MA60下'], note: '趋势：收盘相对 60 日均线位置' },
  { name: 'macd', order: ['DIF>0&金叉', 'DIF>0&死叉', 'DIF<0&金叉', 'DIF<0&死叉'], note: '趋势：MACD 四象限' },
  { name: 'pctFrom60Low', order: ['0-10%', '10-20%', '20-30%', '>30%'], note: '位置：距 60 日最低价涨幅（新口径）' },
  { name: 'ddFrom60High', order: ['>-5%', '-15~-5%', '-30~-15%', '<=-30%'], note: '位置：距 60 日最高价回撤' },
  { name: 't0Turnover', order: ['<3', '3-5', '5-10', '10-15', '>=15'], note: '量能：试盘日换手率 %' },
  { name: 'shadowOfAmp', order: ['<40%', '40-60%', '60-80%', '>=80%'], note: '结构：上影占当日振幅比' },
  { name: 'vetoCombo', order: ['否', '是'], note: '一票否决：量比>5 且 换手>10%' },
  { name: 'shadowRatio', order: ['1.2-2', '2-3', '3-5', '>=5'], note: '参考：上影/实体比（外部称 ≥3 最优）' },
  { name: 'upperShadowPct', order: ['1.5-2%', '2-3%', '3-5%', '>=5%'], note: '参考：上影绝对幅度（外部称 ≥5% 最优）' },
];

function stats(arr: number[]): { n: number; win: number; avg: number } {
  const n = arr.length;
  if (!n) return { n: 0, win: 0, avg: 0 };
  return {
    n,
    win: round((arr.filter((x) => x > 0).length / n) * 100),
    avg: round(arr.reduce((a, b2) => a + b2, 0) / n),
  };
}

function report(rows: Sample[]): void {
  console.log(`\n样本总数 n=${rows.length}（生产门槛、剔924、2022-2026）`);
  const base = stats(rows.map((r) => r.rT1));
  const base5 = stats(rows.map((r) => r.rT5));
  console.log(`基线：T+1冲高 ${base.win}% / 均值 ${base.avg}% ；T+5累计 ${base5.win}% / 均值 ${base5.avg}%`);
  const years = [...new Set(rows.map((r) => r.year))].sort();

  for (const f of FACTORS) {
    console.log(`\n### ${f.name} — ${f.note}`);
    console.log('  档位'.padEnd(20) + 'n'.padStart(6) + 'T+1胜率'.padStart(9) + 'T+1均值'.padStart(9) + 'T+5胜率'.padStart(9) + '   逐年T+1胜率');
    for (const label of f.order) {
      const sel = rows.filter((r) => r.f[f.name] === label);
      if (!sel.length) { console.log('  ' + label.padEnd(18) + '0'.padStart(6)); continue; }
      const s1 = stats(sel.map((r) => r.rT1));
      const s5 = stats(sel.map((r) => r.rT5));
      const perYear = years
        .map((y) => {
          const ys = sel.filter((r) => r.year === y);
          return ys.length ? `${y.slice(2)}:${stats(ys.map((r) => r.rT1)).win}/${ys.length}` : null;
        })
        .filter(Boolean)
        .join(' ');
      console.log(
        '  ' + label.padEnd(18) +
        String(s1.n).padStart(6) +
        String(s1.win).padStart(9) +
        String(s1.avg).padStart(9) +
        String(s5.win).padStart(9) +
        '   ' + perYear
      );
    }
  }
}

function selfTest(): void {
  console.log('b():', b(1.5, [2, 3], ['a', 'b', 'c']), b(2.5, [2, 3], ['a', 'b', 'c']), b(null, [2, 3], ['a', 'b', 'c']));
  const closes = Array.from({ length: 60 }, (_, i) => 10 + i * 0.1);
  const e12 = ema(closes, 12), e26 = ema(closes, 26);
  const dif = closes.map((_, i) => e12[i] - e26[i]);
  const dea = ema(dif, 9);
  console.log('uptrend MACD 末值 dif/dea:', round(dif[59], 4), round(dea[59], 4), '（上升趋势应为 DIF>DEA>0）');
  const down = closes.slice().reverse();
  const d12 = ema(down, 12), d26 = ema(down, 26);
  const ddif = down.map((_, i) => d12[i] - d26[i]);
  const ddea = ema(ddif, 9);
  console.log('downtrend MACD 末值 dif/dea:', round(ddif[59], 4), round(ddea[59], 4), '（下降趋势应为 DIF<DEA<0）');
  console.log('factors:', FACTORS.map((f) => f.name).join(', '));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) { selfTest(); return; }
  // 口径守卫：本脚本的信号池必须是「含确认日缩量门槛」的生产口径。
  // 若运行环境的 lib/strategy/xian-ren-zhi-lu.ts 落后于工作区（缺 confVolRatioMax），
  // detectXianRenAt 会静默忽略该键 → 跑出基线 87.6% 的另一个池子，结论不可比。
  if (!('confVolRatioMax' in DEFAULT_XIANREN_CONFIG)) {
    throw new Error(
      'lib/strategy/xian-ren-zhi-lu.ts 缺少 confVolRatioMax：请先把工作区版本同步到运行环境，再跑本脚本。'
    );
  }
  const yearsArg = args.find((a) => a.startsWith('--years='));
  const years = yearsArg ? yearsArg.slice('--years='.length).split(',').map((s) => s.trim()).filter(Boolean) : YEARS;

  const latestRow = await prisma.dailyBar.findFirst({ orderBy: { tradeDate: 'desc' }, select: { tradeDate: true } });
  if (!latestRow) throw new Error('no daily bars');
  const latestDate = latestRow.tradeDate;

  const acc: Acc = { rows: [] };
  const t0 = Date.now();
  for (const year of years) {
    const loadStart = `${Number(year) - 1}0701`;
    const rawEnd = `${Number(year) + 1}0110`;
    const loadEnd = rawEnd < latestDate ? rawEnd : latestDate;
    const raw = await loadBars(loadStart, loadEnd);
    processRaw(raw, year, acc);
    console.log(`[chunk] ${year} window ${loadStart}~${loadEnd} rows=${raw.length} signals=${acc.rows.length} elapsed=${Date.now() - t0}ms`);
  }

  report(acc.rows);
  console.log('\ntotal elapsed', Date.now() - t0, 'ms');
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
