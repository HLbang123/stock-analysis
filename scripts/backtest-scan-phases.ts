/**
 * 全市场扫描「阶段条件」归因回放（不落库、不改生产）
 *
 * 实验设计：
 *   对照组 = 仅基底（RPS60 ≥ --base-rps，与扫描器默认口径一致）
 *   处理组 = 基底 + 单条件（每条趋势条件单独评估边际贡献）
 *   预设组 = 基底 + 启动期/上升期/回踩整理（UI 预设的完整组合）
 *   消融组 = 上升期预设逐个拆掉单条件（哪条没在干活就砍哪条）
 *   阈值扫描 = 多头排列天数 / 距新高幅度 / 乖离上限 的网格（输出直接指导 UI 档位与默认值）
 *
 * 口径（吸取 a-share-accumulation-breakout 的教训）：
 *   - 信号日 T 收盘后可见 → 入场锚定 T+1 收盘（不是 T 收盘，也不是采样日）
 *   - 前复权：close/high × adj_factor / 窗口内最新因子（除权日假跳空不污染 MA/新高）
 *   - 条件语义与 app/api/scan/route.ts 的 SQL 完全对齐（改 SQL 时同步改这里）
 *
 * 指标：T+1/5/20 胜率 + T+5 均值 + 相对对照组超额；预设组附分年拆分（看 regime 敏感性）
 *
 * 用法: npx tsx scripts/backtest-scan-phases.ts [--stocks=500] [--days=1500] [--base-rps=87]
 *   --base-rps=0 关闭基底过滤（看条件在全市场的裸表现）
 * 注意：rps_scores 历史覆盖之外的 stock-day 自动跳过（基底无法判定），开头打印覆盖率
 */

import { prisma } from '../lib/db';
import { boxFeatures } from '../lib/box';

const DAYS = parseInt(process.argv.find((a) => a.startsWith('--days='))?.split('=')[1] || '1500');
const MAX_STOCKS = parseInt(process.argv.find((a) => a.startsWith('--stocks='))?.split('=')[1] || '500');
const BASE_RPS = parseFloat(process.argv.find((a) => a.startsWith('--base-rps='))?.split('=')[1] || '87');

const WARMUP = 250; // 距一年新高需要的最少历史根数
const FWD = 20;     // 最长前瞻 T+20

interface Bar { date: string; c: number; h: number; l: number; v: number } // c/h/l 已前复权
interface Acc {
  n: number;
  days: Set<string>;
  t1: number[]; t5: number[]; t20: number[];
  byYear: Map<string, { n: number; win5: number; sum5: number }>;
}
const newAcc = (): Acc => ({ n: 0, days: new Set(), t1: [], t5: [], t20: [], byYear: new Map() });
const winRate = (xs: number[]) => (xs.length ? Math.round((xs.filter((x) => x > 0).length / xs.length) * 1000) / 10 : null);
const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);

/** 预计算单标的的全部滑窗序列（ma/high250/vol 均值），条件判定退化为数组读 */
interface StockWin {
  bars: Bar[];
  ma5: (number | null)[];
  ma13: (number | null)[];
  ma55: (number | null)[];
  hi250: (number | null)[];   // 含当日的 250 根 rolling max(high)
  vol5: (number | null)[];    // 近 5 根均量
  vol20p: (number | null)[];  // 前 20 根均量（5~24 根前）
}

function smaArr(xs: number[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(xs.length).fill(null);
  let sum = 0;
  for (let i = 0; i < xs.length; i++) {
    sum += xs[i];
    if (i >= n) sum -= xs[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

function buildWin(bars: Bar[]): StockWin {
  const closes = bars.map((b) => b.c);
  const vols = bars.map((b) => b.v);
  // 250 根 rolling max(high)：单调队列；不足 250 根时用已有窗口（新股），60 根起评
  const hi250: (number | null)[] = new Array(bars.length).fill(null);
  const q: number[] = []; // 单调递减队列存下标
  for (let i = 0; i < bars.length; i++) {
    while (q.length && bars[q[q.length - 1]].h <= bars[i].h) q.pop();
    q.push(i);
    while (q.length && q[0] < i - (WARMUP - 1)) q.shift();
    if (i >= 59) hi250[i] = bars[q[0]].h;
  }
  const volSma5 = smaArr(vols, 5);
  // 前 20 根均量：vol20p[i] = mean(vol[i-24..i-5])
  const vol20p: (number | null)[] = new Array(bars.length).fill(null);
  let vsum = 0;
  for (let i = 0; i < bars.length; i++) {
    const add = i - 5;   // 进入窗口的下标
    const del = i - 25;  // 离开窗口的下标
    if (add >= 0) vsum += vols[add];
    if (del >= 0) vsum -= vols[del];
    if (add >= 19) vol20p[i] = vsum / 20;
  }
  return { bars, ma5: smaArr(closes, 5), ma13: smaArr(closes, 13), ma55: smaArr(closes, 55), hi250, vol5: volSma5, vol20p };
}

// ── 条件谓词（与 scan route SQL 语义对齐）─────────────────────────────
type Pred = (s: StockWin, i: number) => boolean;

const gcFresh = (days: number): Pred => (s, i) => {
  for (let j = Math.max(1, i - days + 1); j <= i; j++) {
    const a5 = s.ma5[j], a13 = s.ma13[j], p5 = s.ma5[j - 1], p13 = s.ma13[j - 1];
    if (a5 != null && a13 != null && p5 != null && p13 != null && p5 <= p13 && a5 > a13) return true;
  }
  return false;
};
const gcApproaching: Pred = (s, i) => {
  const a5 = s.ma5[i], a13 = s.ma13[i], p5 = i > 0 ? s.ma5[i - 1] : null;
  if (a5 == null || a13 == null || p5 == null || a13 === 0) return false;
  return a5 < a13 && (a13 - a5) / a13 < 0.02 && a5 > p5;
};
const ma55Up: Pred = (s, i) => s.ma55[i] != null && s.bars[i].c > s.ma55[i]!;
const mbDays = (n: number): Pred => (s, i) => {
  for (let j = i - n + 1; j <= i; j++) {
    const a5 = s.ma5[j], a13 = s.ma13[j], a55 = s.ma55[j];
    if (a5 == null || a13 == null || a55 == null || !(a5 > a13 && a13 > a55)) return false;
  }
  return true;
};
const maRising: Pred = (s, i) => {
  if (i < 5) return false;
  const keys: ('ma5' | 'ma13' | 'ma55')[] = ['ma5', 'ma13', 'ma55'];
  return keys.every((k) => s[k][i] != null && s[k][i - 5] != null && s[k][i]! > s[k][i - 5]!);
};
const nearHigh = (x: number): Pred => (s, i) => s.hi250[i] != null && s.bars[i].c >= s.hi250[i]! * (1 - x / 100);
const bias55 = (lo: number, hi: number): Pred => (s, i) => {
  const m = s.ma55[i];
  if (m == null || m === 0) return false;
  const b = (s.bars[i].c / m - 1) * 100;
  return b >= lo && b <= hi;
};
const pbMa13 = (lo: number, hi: number): Pred => (s, i) => {
  const m = s.ma13[i];
  if (m == null || m === 0) return false;
  const b = (s.bars[i].c / m - 1) * 100;
  return b >= lo && b <= hi;
};
const volShrink: Pred = (s, i) => s.vol5[i] != null && s.vol20p[i] != null && s.vol5[i]! < s.vol20p[i]!;
// 吸筹箱体（lib/box.ts，与 scan route 同口径：窗口含最新一根；breakout 带 1.6×箱均量确认）
const boxPred = (mode: 'in' | 'breakout'): Pred => (s, i) => {
  const from = Math.max(0, i - 59);
  const closes = s.bars.slice(from, i + 1).map((b) => b.c);
  const highs = s.bars.slice(from, i + 1).map((b) => b.h);
  const lows = s.bars.slice(from, i + 1).map((b) => b.l);
  const box = boxFeatures(closes, highs, lows, 60);
  if (!box.inBox || box.boxPos == null) return false;
  if (mode === 'in') return box.boxPos >= 0 && box.boxPos <= 1;
  if (box.boxPos <= 1) return false;
  const win = s.bars.slice(Math.max(0, i - 60), i);
  const avgV = win.length ? win.reduce((a, b) => a + b.v, 0) / win.length : 0;
  return avgV > 0 && s.bars[i].v >= avgV * 1.6;
};

const and = (...ps: Pred[]): Pred => (s, i) => ps.every((p) => p(s, i));
const or = (...ps: Pred[]): Pred => (s, i) => ps.some((p) => p(s, i));

async function main() {
  console.log(`[scan-bt] 阶段条件归因回放：样本 ${MAX_STOCKS} 只 × ${DAYS} 交易日，基底 RPS60≥${BASE_RPS}（0=关闭），入场 T+1 收盘`);

  const latest = await prisma.dailyBar.findFirst({ orderBy: { tradeDate: 'desc' }, select: { tradeDate: true } });
  if (!latest) { console.log('无日线数据'); return; }

  const active = await prisma.stock.findMany({ where: { isActive: true }, select: { tsCode: true }, orderBy: { tsCode: 'asc' } });
  const step = Math.max(1, Math.ceil(active.length / MAX_STOCKS));
  const sample = active.filter((_, i) => i % step === 0).slice(0, MAX_STOCKS).map((s) => s.tsCode);

  // 评估窗口 DAYS 个交易日 + WARMUP 预热 ≈ (DAYS + 250) × 1.5 日历日
  const start = new Date();
  start.setDate(start.getDate() - Math.ceil((DAYS + WARMUP) * 1.5));
  const startDate = start.toISOString().slice(0, 10).replace(/-/g, '');

  const bars = await prisma.dailyBar.findMany({
    where: { tsCode: { in: sample }, tradeDate: { gte: startDate } },
    select: { tsCode: true, tradeDate: true, close: true, high: true, low: true, vol: true, adjFactor: true },
    orderBy: [{ tsCode: 'asc' }, { tradeDate: 'asc' }],
  });

  // 分组 + 前复权归一（× adj_factor / 窗口内最新因子）：除权日假跳空不污染 MA/新高；
  // adj_factor 缺失时退化为原始价（与 scan route 的 COALESCE 口径一致）
  const byStock = new Map<string, Bar[]>();
  {
    const raw = new Map<string, { date: string; c: number; h: number; l: number; v: number; adj: number }[]>();
    for (const b of bars) {
      if (b.close == null || b.vol == null) continue;
      let arr = raw.get(b.tsCode);
      if (!arr) { arr = []; raw.set(b.tsCode, arr); }
      arr.push({ date: b.tradeDate, c: b.close, h: b.high ?? b.close, l: b.low ?? b.close, v: b.vol, adj: b.adjFactor ?? 1 });
    }
    for (const [code, arr] of raw) {
      const latestAdj = arr[arr.length - 1].adj || 1;
      byStock.set(code, arr.map((r) => ({ date: r.date, c: (r.c * r.adj) / latestAdj, h: (r.h * r.adj) / latestAdj, l: (r.l * r.adj) / latestAdj, v: r.v })));
    }
  }

  // RPS60 历史（基底过滤用；覆盖外的 stock-day 跳过）
  const rpsRows = BASE_RPS > 0
    ? await prisma.rpsScore.findMany({
        where: { tsCode: { in: sample }, calcDate: { gte: startDate } },
        select: { tsCode: true, calcDate: true, rps60: true },
      })
    : [];
  const rpsMap = new Map<string, Map<string, number>>();
  for (const r of rpsRows) {
    if (r.rps60 == null) continue;
    let m = rpsMap.get(r.tsCode);
    if (!m) { m = new Map(); rpsMap.set(r.tsCode, m); }
    m.set(r.calcDate, r.rps60);
  }

  // 组定义：对照/单条件/预设/消融/阈值扫描
  const groups: { key: string; f: Pred; yearly?: boolean }[] = [
    { key: '对照组(仅基底)', f: () => true },
    { key: '+金叉(近5日∨即将)', f: or(gcFresh(5), gcApproaching) },
    { key: '+站上55日线', f: ma55Up },
    { key: '+多头排列10日', f: mbDays(10) },
    { key: '+三线上行', f: maRising },
    { key: '+距年新高≤25%', f: nearHigh(25) },
    { key: '+乖离0~30%', f: bias55(0, 30) },
    { key: '+贴MA13(-3~5%)', f: pbMa13(-3, 5) },
    { key: '+缩量整理', f: volShrink },
    { key: '+吸筹箱体', f: boxPred('in') },
    { key: '+突破箱体', f: boxPred('breakout') },
    { key: '预设·启动期', f: and(or(gcFresh(5), gcApproaching), ma55Up), yearly: true },
    { key: '预设·上升期', f: and(mbDays(10), maRising, nearHigh(25), bias55(0, 30)), yearly: true },
    { key: '预设·回踩整理', f: and(mbDays(10), pbMa13(-3, 5), volShrink), yearly: true },
    { key: '消融·上升期−近新高', f: and(mbDays(10), maRising, bias55(0, 30)) },
    { key: '消融·上升期−三线上行', f: and(mbDays(10), nearHigh(25), bias55(0, 30)) },
    { key: '消融·上升期−乖离', f: and(mbDays(10), maRising, nearHigh(25)) },
    { key: '消融·上升期−多头', f: and(maRising, nearHigh(25), bias55(0, 30)) },
  ];
  const sweeps: { title: string; rows: { key: string; f: Pred }[] }[] = [
    { title: '多头排列持续天数（单条件）', rows: [3, 5, 10, 15, 20].map((n) => ({ key: `≥${n}日`, f: mbDays(n) })) },
    { title: '距一年新高幅度（单条件）', rows: [10, 15, 25, 40].map((x) => ({ key: `≤${x}%`, f: nearHigh(x) })) },
    { title: '乖离率上限（下限0固定，单条件）', rows: [20, 30, 50].map((x) => ({ key: `0~${x}%`, f: bias55(0, x) })) },
  ];

  const accs = groups.map(() => newAcc());
  const sweepAccs = sweeps.map((sw) => sw.rows.map(() => newAcc()));

  let processed = 0;
  let rpsCovered = 0, rpsTotal = 0;
  for (const [code, arr] of byStock) {
    if (arr.length < WARMUP + FWD + 2) continue;
    const s = buildWin(arr);
    const rpsOf = rpsMap.get(code);
    for (let i = WARMUP - 1; i < arr.length - (FWD + 2); i++) {
      // 基底：RPS60 ≥ 阈值（rps 覆盖外跳过）
      if (BASE_RPS > 0) {
        rpsTotal++;
        const rps = rpsOf?.get(arr[i].date);
        if (rps == null) continue;
        rpsCovered++;
        if (rps < BASE_RPS) continue;
      }
      const entry = arr[i + 1].c; // T+1 收盘入场
      if (entry <= 0) continue;
      const r1 = (arr[i + 2].c / entry - 1) * 100;
      const r5 = (arr[i + 6].c / entry - 1) * 100;
      const r20 = (arr[i + 21].c / entry - 1) * 100;
      const year = arr[i].date.slice(0, 4);

      const hit = (a: Acc) => {
        a.n++; a.days.add(arr[i].date);
        a.t1.push(r1); a.t5.push(r5); a.t20.push(r20);
        let y = a.byYear.get(year);
        if (!y) { y = { n: 0, win5: 0, sum5: 0 }; a.byYear.set(year, y); }
        y.n++; if (r5 > 0) y.win5++; y.sum5 += r5;
      };
      for (let g = 0; g < groups.length; g++) if (groups[g].f(s, i)) hit(accs[g]);
      for (let sw = 0; sw < sweeps.length; sw++)
        for (let r = 0; r < sweeps[sw].rows.length; r++)
          if (sweeps[sw].rows[r].f(s, i)) hit(sweepAccs[sw][r]);
    }
    processed++;
    if (processed % 100 === 0) console.log(`[scan-bt] 进度 ${processed}/${byStock.size}`);
  }

  if (BASE_RPS > 0) console.log(`[scan-bt] RPS 覆盖率 ${((rpsCovered / Math.max(rpsTotal, 1)) * 100).toFixed(1)}%（覆盖外 stock-day 已跳过）`);

  const base = accs[0];
  const baseWin5 = winRate(base.t5);
  const line = (key: string, a: Acc) => {
    const w5 = winRate(a.t5);
    const excess = baseWin5 != null && w5 != null ? `${(w5 - baseWin5 >= 0 ? '+' : '')}${(w5 - baseWin5).toFixed(1)}pp` : '--';
    const daysN = Math.max(a.days.size, 1);
    console.log(`  ${key.padEnd(18)} 样本${String(a.n).padStart(7)}  日均命中${(a.n / daysN).toFixed(1).padStart(6)}  T+1胜率${String(winRate(a.t1)).padStart(5)}%  T+5胜率${String(w5).padStart(5)}%(${excess})  T+5均值${String(mean(a.t5)).padStart(6)}%  T+20胜率${String(winRate(a.t20)).padStart(5)}%`);
  };

  console.log('\n=== 对照组 vs 单条件 vs 预设 vs 消融 ===');
  groups.forEach((g, gi) => {
    line(g.key, accs[gi]);
    if (g.yearly) {
      const years = [...accs[gi].byYear.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      console.log(`    分年: ${years.map(([y, v]) => `${y} ${Math.round((v.win5 / v.n) * 100)}%(n=${v.n})`).join('  ')}`);
    }
  });
  sweeps.forEach((sw, swi) => {
    console.log(`\n=== 扫描：${sw.title} ===`);
    sw.rows.forEach((r, ri) => line(r.key, sweepAccs[swi][ri]));
  });
  console.log('\n口径：信号日 T 收盘后可见 → T+1 收盘入场；T+N 为入场后 N 个交易日收盘收益；超额=T+5胜率−对照组。');
}

main().catch((e) => { console.error(e); process.exit(1); });
