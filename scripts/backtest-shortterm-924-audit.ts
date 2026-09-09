/**
 * 超短线四策略 · 924 剔除复检（板三阴 / 龙首阴 / 双龙 / 龙四阴）
 *
 * 背景：这四套策略的规则与参数（实体上限、量比上限、换手板门槛、首板是否卡突破/放量、
 *       龙四阴放量+近新高）都是在「含 2024-09-24 ~ 10-08 普涨行情」的回测上定的。
 *       仙人指路已证明该窗口会把 β 当 α，故此处用同一口径复检。
 *
 * 口径（与 docs/sector-xianren-backtest-spec.md 一致）：
 *   - 主板非 ST：600/601/603/605/000/001/002/003，is_active，name 不含 ST/退。
 *   - 原始价（不乘 adj_factor），与生产 data-source.ts 同源口径；preClose 优先取库内 pre_close。
 *   - 收益：T+1 开盘 / T+1 最高 / T+1 收盘 / T+5 累计最高（相对买点）。
 *   - 三种样本口径：
 *       all      = 全部信号（复现旧结论）
 *       ex924    = 信号日落在 2024-09-24~2024-10-08 的剔除（spec 口径）
 *       strict   = 信号日或持有窗口(T+1..T+5)任意一天落在该区间的剔除（更严，防 β 泄漏）
 *
 * 方法：每套策略用「宽松 config」跑生产检测函数，命中即记录该信号的全部可判定指标，
 *       再用变体谓词在离线结果上做门槛扫描。检测只跑一遍，避免重复扫描。
 *
 * 用法：
 *   npx tsx scripts/backtest-shortterm-924-audit.ts --selftest
 *   npx tsx scripts/backtest-shortterm-924-audit.ts --years=2024          # 小窗
 *   npx tsx scripts/backtest-shortterm-924-audit.ts --years=2017,2018,...  # 指定年份
 *   npx tsx scripts/backtest-shortterm-924-audit.ts                        # 默认 2017~2026
 *
 * 服务器长跑：NODE_OPTIONS=--max-old-space-size=2048 setsid nohup npx tsx ... > /tmp/x.log 2>&1 &
 */

import { prisma } from '../lib/db';
import { detectLimitUpThreeYinAt, ThreeYinBar } from '../lib/strategy/limit-up-three-yin';
import { detectDragonFirstYinAt, DragonBar } from '../lib/strategy/dragon-first-yin';
import { detectDoubleDragonBoard, DoubleDragonBar } from '../lib/strategy/double-dragon';
import { detectDragonFourYinAt, DragonFourYinBar } from '../lib/strategy/dragon-four-yin';

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
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  preClose: number | null;
  turnoverRate: number | null;
}

/** 一条结构信号 + 全部可判定指标 + 前向收益 */
interface Row {
  code: string;
  date: string;      // 买点日
  year: string;
  entry: number;
  rOpen: number;     // T+1 开盘
  rHigh: number;     // T+1 最高
  rClose: number;    // T+1 收盘
  r5Cum: number;     // T+5 累计最高
  inWin: boolean;    // 信号日落在 924 窗口
  ov: boolean;       // 信号日或持有窗口触及 924 窗口
  key?: string;      // 分组键（双龙回踩：同一组二板只取最早命中的回踩日）
  m: Record<string, number | boolean | string | null>;
}

const EX_LO = '2024-09-24';
const EX_HI = '2024-10-08';
const DEFAULT_YEARS = ['2017', '2018', '2019', '2020', '2021', '2022', '2023', '2024', '2025', '2026'];

const round = (n: number, d = 2): number => {
  const p = Math.pow(10, d);
  return Math.round(n * p) / p;
};
const round4 = (n: number): number => Math.round(n * 10000) / 10000;
const fmtDate = (d: string): string =>
  d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d;

function stats(arr: number[]): { n: number; win: number; avg: number } {
  const n = arr.length;
  if (!n) return { n: 0, win: 0, avg: 0 };
  const avg = arr.reduce((a, b) => a + b, 0) / n;
  const win = arr.filter((x) => x > 0).length / n;
  return { n, win: round(win * 100), avg: round(avg) };
}
function gt2(arr: number[]): number {
  const n = arr.length;
  return n ? round((arr.filter((x) => x > 2).length / n) * 100) : 0;
}

/**
 * 前置筛选（同生产 data-source.ts 思路）：四套策略的形态里都必然含涨停日，
 * 故先在 SQL 层只取「窗口内出现过涨停」的 ts_code，再拉这些标的的完整序列。
 * 涨停超集口径：change_pct >= 9.5 或 close/high 同时 >= pre_close*1.095（防 change_pct 缺失）。
 */
function loadCandidateCodes(start: string, end: string): Promise<{ tsCode: string }[]> {
  const sql = [
    'SELECT DISTINCT b."tsCode" AS "tsCode"',
    'FROM daily_bars b',
    'JOIN stocks s ON s.ts_code = b."tsCode"',
    'WHERE b."tradeDate" >= $1 AND b."tradeDate" <= $2',
    '  AND s.is_active = true',
    "  AND s.ts_code ~ '^(600|601|603|605|000|001|002|003)'",
    "  AND s.name !~ '(ST|退)'",
    '  AND (b.change_pct >= 9.5 OR (b.pre_close > 0 AND b.close >= b.pre_close * 1.095 AND b.high >= b.pre_close * 1.095))',
  ].join('\n');
  return prisma.$queryRawUnsafe<{ tsCode: string }[]>(sql, start, end);
}

function loadBars(codes: string[] | null, start: string, end: string): Promise<RawBar[]> {
  const base = [
    'SELECT b."tsCode" AS "tsCode", b."tradeDate" AS "tradeDate",',
    '       b.open, b.high, b.low, b.close, b.pre_close AS "preClose", b.vol,',
    '       b.turnover_rate AS "turnoverRate"',
    'FROM daily_bars b',
    'JOIN stocks s ON s.ts_code = b."tsCode"',
  ];
  if (codes) {
    if (!codes.length) return Promise.resolve([]);
    const sql = base.concat([
      'WHERE b."tsCode" = ANY($1)',
      '  AND b."tradeDate" >= $2 AND b."tradeDate" <= $3',
    ]).join('\n');
    return prisma.$queryRawUnsafe<RawBar[]>(sql, codes, start, end);
  }
  const sql = base.concat([
    'WHERE b."tradeDate" >= $1 AND b."tradeDate" <= $2',
    '  AND s.is_active = true',
    "  AND s.ts_code ~ '^(600|601|603|605|000|001|002|003)'",
    "  AND s.name !~ '(ST|退)'",
  ]).join('\n');
  return prisma.$queryRawUnsafe<RawBar[]>(sql, start, end);
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** 涨停候选（主板 10%），口径与引擎 isLimitUp 一致 */
function isLuAt(bars: Bar[], k: number): boolean {
  if (k < 0 || k >= bars.length) return false;
  const b = bars[k];
  const prev = b.preClose != null && b.preClose > 0 ? b.preClose : k > 0 ? bars[k - 1].close : null;
  if (prev == null || prev <= 0) return false;
  const lim = round2(prev * 1.1);
  return Math.abs(b.close - lim) <= 0.011 && b.high >= lim - 0.011;
}

function avgVol(bars: Bar[], from: number, to: number): number {
  let s = 0, c = 0;
  for (let j = from; j < to; j++) {
    if (j >= 0) { s += bars[j].volume; c++; }
  }
  return c > 0 ? s / c : 0;
}

interface Acc {
  sy: Row[];
  dfy: Row[];
  ddBoard: Row[];
  d4: Row[];
}

function emptyAcc(): Acc {
  return { sy: [], dfy: [], ddBoard: [], d4: [] };
}

function pushRow(
  acc: Row[],
  bars: Bar[],
  code: string,
  entryIdx: number,
  entry: number,
  m: Record<string, number | boolean | string | null>,
  key?: string
): void {
  if (!(entry > 0)) return;
  const b1 = bars[entryIdx + 1];
  if (!b1) return;
  const date = bars[entryIdx].date;
  const inWin = date >= EX_LO && date <= EX_HI;
  let ov = inWin;
  let cum = -Infinity;
  let complete = true;
  for (let n = 1; n <= 5; n++) {
    const b = bars[entryIdx + n];
    if (!b) { complete = false; break; }
    if (b.date >= EX_LO && b.date <= EX_HI) ov = true;
    if (b.high > cum) cum = b.high;
  }
  if (!complete) return; // T+5 不完整的样本一律丢弃（避免窗口末尾偏乐观）
  acc.push({
    code,
    date,
    year: date.slice(0, 4),
    entry,
    rOpen: round(((b1.open - entry) / entry) * 100),
    rHigh: round(((b1.high - entry) / entry) * 100),
    rClose: round(((b1.close - entry) / entry) * 100),
    r5Cum: round(((cum - entry) / entry) * 100),
    inWin,
    ov,
    key,
    m,
  });
}

function processRaw(raw: RawBar[], year: string, acc: Acc): void {
  const byCode = new Map<string, RawBar[]>();
  for (const r of raw) {
    if (r.open == null || r.close == null || r.high == null || r.low == null) continue;
    if (!byCode.has(r.tsCode)) byCode.set(r.tsCode, []);
    byCode.get(r.tsCode)!.push(r);
  }

  for (const rawBars of byCode.values()) {
    rawBars.sort((a, b) => (a.tradeDate < b.tradeDate ? -1 : 1));
    const bars: Bar[] = rawBars.map((r) => ({
      date: fmtDate(r.tradeDate),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.vol ?? 0),
      preClose: r.preClose != null ? Number(r.preClose) : null,
      turnoverRate: r.turnoverRate != null ? Number(r.turnoverRate) : null,
    }));
    if (bars.length < 70) continue;
    const code = rawBars[0].tsCode;

    // ---------- 板三阴：结构 = 涨停(非一字) + 高开创新高 + 三根阴线 ----------
    for (let i = 3; i < bars.length; i++) {
      if (bars[i].date.slice(0, 4) !== year) continue;
      if (!(bars[i].close < bars[i].open && bars[i - 1].close < bars[i - 1].open && bars[i - 2].close < bars[i - 2].open)) continue;
      if (!isLuAt(bars, i - 3)) continue;
      const sig = detectLimitUpThreeYinAt(bars as ThreeYinBar[], i, {
        minYinBodyPct: 0,
        maxYinBodyPct: 1e9,
        requireTrueYin: false,
      });
      if (!sig.matched) continue;
      const [v0, v1, v2, v3] = sig.metrics.volumes;
      pushRow(acc.sy, bars, code, i, sig.metrics.entryClose, {
        b0: sig.metrics.yinBodies[0],
        b1: sig.metrics.yinBodies[1],
        b2: sig.metrics.yinBodies[2],
        maxBody: Math.max(...sig.metrics.yinBodies),
        minBody: Math.min(...sig.metrics.yinBodies),
        trueYin2: bars[i - 1].close < bars[i - 2].close, // 第二阴相对第一阴（引擎 requireTrueYin 检查项）
        trueYin3: bars[i].close < bars[i - 1].close,     // 第三阴相对第二阴
        volDec: v0 > v1 && v1 > v2 && v2 > v3,
        volShrink: v3 < avgVol(bars, i - 5, i),
        volRatio3: avgVol(bars, i - 5, i) > 0 ? round(v3 / avgVol(bars, i - 5, i)) : null,
      });
    }

    // ---------- 龙首阴：结构 = 3+连板后第一根阴线 / 长下影分歧转一致 ----------
    for (let i = 1; i < bars.length; i++) {
      if (bars[i].date.slice(0, 4) !== year) continue;
      if (!isLuAt(bars, i - 1)) continue;
      const sig = detectDragonFirstYinAt(bars as DragonBar[], i, {
        minTurnoverRate: 0,
        yinBodyMaxPct: 1e9,
        maxVolumeRatio: 1e9,
        maxYinTurnoverRate: 1e9,
        requireFakeYinAtHighBoards: false,
        rejectLimitDownYin: false,
        skipAllOneWordRun: false,
      });
      if (!sig.matched || !sig.run || !sig.yin) continue;
      const run = sig.run;
      const yin = sig.yin;
      const changeBoards = run.boards.filter((b) => !b.oneWord);
      const changeTurnovers = changeBoards.map((b) => b.turnoverRate).filter((x): x is number => x != null);
      const minChangeTurnover = changeTurnovers.length ? Math.min(...changeTurnovers) : Infinity;
      const maxChangeTurnover = changeTurnovers.length ? Math.max(...changeTurnovers) : -Infinity;
      pushRow(acc.dfy, bars, code, i, yin.close, {
        boardCount: run.boardCount,
        quality: run.quality,
        changeCount: run.changeCount,
        oneWordCount: run.oneWordCount,
        trailingOneWord: run.trailingOneWordStreak,
        minChangeTurnover: Number.isFinite(minChangeTurnover) ? round4(minChangeTurnover) : null,
        maxChangeTurnover: Number.isFinite(maxChangeTurnover) ? round4(maxChangeTurnover) : null,
        avgChangeTurnover: changeTurnovers.length ? round4(changeTurnovers.reduce((a, b) => a + b, 0) / changeTurnovers.length) : null,
        bodyPct: yin.bodyPct,
        changePct: yin.changePct,
        fakeYin: yin.fakeYin,
        realYin: yin.realYin,
        isWash: yin.isWash,
        volumeRatio: yin.volumeRatio,
        turnoverRate: yin.turnoverRate,
        atLimitDown: yin.atLimitDown,
      });
    }

    // ---------- 双龙：结构 = 首板非一字 + 恰好二板 ----------
    for (let i = 2; i < bars.length; i++) {
      if (bars[i].date.slice(0, 4) !== year) continue;
      if (!(isLuAt(bars, i - 1) && isLuAt(bars, i))) continue;
      const sig = detectDoubleDragonBoard(bars as DoubleDragonBar[], i, {});
      if (sig.matched) {
        // 首板 60 日突破 / 放量（旧口径被砍掉的两个条件）
        let mx = 0;
        for (let j = Math.max(0, i - 1 - 60); j < i - 1; j++) mx = Math.max(mx, bars[j].high);
        const b0 = bars[i - 1];
        const a5 = avgVol(bars, i - 6, i - 1);
        pushRow(acc.ddBoard, bars, code, i, sig.entryPrice, {
          body1: sig.firstBoardBodyPct,
          secondOneWord: sig.secondOneWord,
          breakout60: mx > 0 ? b0.close > mx : false,
          volRatio1: a5 > 0 ? round(b0.volume / a5) : null,
          board2VolRatio: avgVol(bars, i - 5, i) > 0 ? round(bars[i].volume / avgVol(bars, i - 5, i)) : null,
        });
      }
      // 【2026-09-11 已删除】双龙回踩取样分支（十年实测负 alpha，已从策略体系移除）
    }

    // ---------- 龙四阴：结构 = 首板涨停(非一字) + 四连阴 ----------
    for (let i = 4; i < bars.length; i++) {
      if (bars[i].date.slice(0, 4) !== year) continue;
      if (!(bars[i].close < bars[i].open && bars[i - 1].close < bars[i - 1].open
        && bars[i - 2].close < bars[i - 2].open && bars[i - 3].close < bars[i - 3].open)) continue;
      if (!isLuAt(bars, i - 4)) continue;
      const sig = detectDragonFourYinAt(bars as DragonFourYinBar[], i, {
        minVolRatio: 0,
        nearHighRatio: 0,
        minBodyPct: 0,
        maxBodyPct: 1e9,
      });
      if (!sig.matched) continue;
      {
        const b0 = bars[i - 4];
        let vsum = 0, vcnt = 0;
        for (let j = i - 4 - 10; j < i - 4; j++) { if (j >= 0) { vsum += bars[j].volume; vcnt++; } }
        const volRatio = vcnt > 0 ? b0.volume / (vsum / vcnt) : null;
        let mx = 0;
        for (let j = Math.max(0, i - 4 - 20); j < i - 4; j++) mx = Math.max(mx, bars[j].high);
        const nearHighPct = mx > 0 ? (b0.close / mx) * 100 : null;
        const body1 = b0.open > 0 ? ((bars[i - 3].open - bars[i - 3].close) / bars[i - 3].open) * 100 : null;
        pushRow(acc.d4, bars, code, i, sig.entryPrice, {
          volRatio: volRatio != null ? round4(volRatio) : null,
          nearHighPct: nearHighPct != null ? round4(nearHighPct) : null,
          body1: body1 != null ? round4(body1) : null,
        });
      }
    }
  }
}

// ============================ 变体定义 ============================

interface Variant {
  name: string;
  note: string;
  pass: (m: Record<string, any>) => boolean;
}

const n = (v: any): number => (v == null ? NaN : Number(v));

const SY_VARIANTS: Variant[] = [
  { name: 'base(6%)', note: '当前生产：实体 0.05~6%、二三阴真阴', pass: (m) => n(m.minBody) >= 0.05 && n(m.maxBody) <= 6.0 && m.trueYin2 && m.trueYin3 },
  { name: 'body5%', note: '旧口径实体上限 5%', pass: (m) => n(m.minBody) >= 0.05 && n(m.maxBody) <= 5.0 && m.trueYin2 && m.trueYin3 },
  { name: 'body4%', note: '实体上限 4%', pass: (m) => n(m.minBody) >= 0.05 && n(m.maxBody) <= 4.0 && m.trueYin2 && m.trueYin3 },
  { name: 'body8%', note: '实体上限 8%', pass: (m) => n(m.minBody) >= 0.05 && n(m.maxBody) <= 8.0 && m.trueYin2 && m.trueYin3 },
  { name: 'base+volDec', note: '叠加量能递减', pass: (m) => n(m.minBody) >= 0.05 && n(m.maxBody) <= 6.0 && m.trueYin2 && m.trueYin3 && m.volDec },
  { name: 'base+volShrink', note: '叠加第三阴缩量(<5日均量)', pass: (m) => n(m.minBody) >= 0.05 && n(m.maxBody) <= 6.0 && m.trueYin2 && m.trueYin3 && m.volShrink },
  { name: 'base-noTrueYin', note: '不要求二三阴真阴', pass: (m) => n(m.minBody) >= 0.05 && n(m.maxBody) <= 6.0 },
];

const DFY_VARIANTS: Variant[] = [
  { name: 'base', note: '当前生产（2026-09-09 起）：至少一个换手板≥8%(MAX)、量比≤2.5、实体≤7%、换手≤45%、5板+假阴真阳、非跌停', pass: (m) => n(m.boardCount) >= 3 && n(m.maxChangeTurnover) >= 8 && n(m.bodyPct) <= 7 && n(m.volumeRatio) <= 2.5 && (m.turnoverRate == null || n(m.turnoverRate) <= 45) && !m.atLimitDown && (n(m.boardCount) < 5 || m.fakeYin || m.isWash) },
  { name: 'turn8min', note: '旧生产口径：每个非一字板都≥8%(MIN)，比文档严', pass: (m) => n(m.boardCount) >= 3 && n(m.minChangeTurnover) >= 8 && n(m.bodyPct) <= 7 && n(m.volumeRatio) <= 2.5 && (m.turnoverRate == null || n(m.turnoverRate) <= 45) && !m.atLimitDown && (n(m.boardCount) < 5 || m.fakeYin || m.isWash) },
  { name: 'vol3', note: '量比上限放宽到 3（更早口径）', pass: (m) => n(m.boardCount) >= 3 && n(m.maxChangeTurnover) >= 8 && n(m.bodyPct) <= 7 && n(m.volumeRatio) <= 3 && (m.turnoverRate == null || n(m.turnoverRate) <= 45) && !m.atLimitDown && (n(m.boardCount) < 5 || m.fakeYin || m.isWash) },
  { name: 'vol2', note: '量比上限收到 2', pass: (m) => n(m.boardCount) >= 3 && n(m.maxChangeTurnover) >= 8 && n(m.bodyPct) <= 7 && n(m.volumeRatio) <= 2 && (m.turnoverRate == null || n(m.turnoverRate) <= 45) && !m.atLimitDown && (n(m.boardCount) < 5 || m.fakeYin || m.isWash) },
  { name: 'turn5', note: '换手板门槛 5（MAX）', pass: (m) => n(m.boardCount) >= 3 && n(m.maxChangeTurnover) >= 5 && n(m.bodyPct) <= 7 && n(m.volumeRatio) <= 2.5 && (m.turnoverRate == null || n(m.turnoverRate) <= 45) && !m.atLimitDown && (n(m.boardCount) < 5 || m.fakeYin || m.isWash) },
  { name: 'turn10', note: '换手板门槛 10（MAX）', pass: (m) => n(m.boardCount) >= 3 && n(m.maxChangeTurnover) >= 10 && n(m.bodyPct) <= 7 && n(m.volumeRatio) <= 2.5 && (m.turnoverRate == null || n(m.turnoverRate) <= 45) && !m.atLimitDown && (n(m.boardCount) < 5 || m.fakeYin || m.isWash) },
  { name: 'turn0', note: '不卡换手板门槛', pass: (m) => n(m.boardCount) >= 3 && n(m.bodyPct) <= 7 && n(m.volumeRatio) <= 2.5 && (m.turnoverRate == null || n(m.turnoverRate) <= 45) && !m.atLimitDown && (n(m.boardCount) < 5 || m.fakeYin || m.isWash) },
  { name: 'body10', note: '实体上限放宽到 10%', pass: (m) => n(m.boardCount) >= 3 && n(m.maxChangeTurnover) >= 8 && n(m.bodyPct) <= 10 && n(m.volumeRatio) <= 2.5 && (m.turnoverRate == null || n(m.turnoverRate) <= 45) && !m.atLimitDown && (n(m.boardCount) < 5 || m.fakeYin || m.isWash) },
  { name: 'highBoardAny', note: '5板+不强制假阴真阳', pass: (m) => n(m.boardCount) >= 3 && n(m.minChangeTurnover) >= 8 && n(m.bodyPct) <= 7 && n(m.volumeRatio) <= 2.5 && (m.turnoverRate == null || n(m.turnoverRate) <= 45) && !m.atLimitDown },
  { name: 'board3', note: '只看 3 板', pass: (m) => n(m.boardCount) === 3 && n(m.maxChangeTurnover) >= 8 && n(m.bodyPct) <= 7 && n(m.volumeRatio) <= 2.5 && (m.turnoverRate == null || n(m.turnoverRate) <= 45) && !m.atLimitDown },
  { name: 'board4plus', note: '只看 4 板及以上', pass: (m) => n(m.boardCount) >= 4 && n(m.maxChangeTurnover) >= 8 && n(m.bodyPct) <= 7 && n(m.volumeRatio) <= 2.5 && (m.turnoverRate == null || n(m.turnoverRate) <= 45) && !m.atLimitDown && (n(m.boardCount) < 5 || m.fakeYin || m.isWash) },
  { name: 'noWash', note: '剔除长下影分歧转一致', pass: (m) => !m.isWash && n(m.boardCount) >= 3 && n(m.maxChangeTurnover) >= 8 && n(m.bodyPct) <= 7 && n(m.volumeRatio) <= 2.5 && (m.turnoverRate == null || n(m.turnoverRate) <= 45) && !m.atLimitDown && (n(m.boardCount) < 5 || m.fakeYin || m.isWash) },
  { name: 'turn8max(旧名)', note: '同 base（文档口径，2026-09-09 起已落地）', pass: (m) => n(m.boardCount) >= 3 && n(m.maxChangeTurnover) >= 8 && n(m.bodyPct) <= 7 && n(m.volumeRatio) <= 2.5 && (m.turnoverRate == null || n(m.turnoverRate) <= 45) && !m.atLimitDown && (n(m.boardCount) < 5 || m.fakeYin || m.isWash) },
  { name: 'board3to5', note: '严格 3~5 板', pass: (m) => n(m.boardCount) >= 3 && n(m.boardCount) <= 5 && n(m.maxChangeTurnover) >= 8 && n(m.bodyPct) <= 7 && n(m.volumeRatio) <= 2.5 && (m.turnoverRate == null || n(m.turnoverRate) <= 45) && !m.atLimitDown && (n(m.boardCount) < 5 || m.fakeYin || m.isWash) },
  { name: 'exAllOneWord', note: '剔除全一字连板段', pass: (m) => m.quality !== 'oneWord' && n(m.boardCount) >= 3 && n(m.maxChangeTurnover) >= 8 && n(m.bodyPct) <= 7 && n(m.volumeRatio) <= 2.5 && (m.turnoverRate == null || n(m.turnoverRate) <= 45) && !m.atLimitDown && (n(m.boardCount) < 5 || m.fakeYin || m.isWash) },
];

const DDB_VARIANTS: Variant[] = [
  { name: 'base', note: '当前生产：首板非一字 + 恰好二板，不卡实体/突破/放量', pass: () => true },
  { name: 'body5', note: '首板实体 ≥5%', pass: (m) => n(m.body1) >= 5 },
  { name: 'breakout60', note: '首板创 60 日新高', pass: (m) => !!m.breakout60 },
  { name: 'vol15', note: '首板量 ≥1.5×前5日均量', pass: (m) => n(m.volRatio1) >= 1.5 },
  { name: 'strictAll', note: '旧严格口径：实体+突破+放量全卡', pass: (m) => n(m.body1) >= 5 && !!m.breakout60 && n(m.volRatio1) >= 1.5 },
  { name: 'body5+vol15', note: '实体+放量', pass: (m) => n(m.body1) >= 5 && n(m.volRatio1) >= 1.5 },
  { name: 'tradable', note: '可成交过滤：二板非一字', pass: (m) => !m.secondOneWord },
  { name: 'onlyOneWord', note: '只看二板一字', pass: (m) => !!m.secondOneWord },
];

// 【2026-09-11 已删除】原 DDP_VARIANTS（双龙回踩变体集）。


const D4_VARIANTS: Variant[] = [
  { name: 'base', note: '当前生产：放量≥1.5×10日均量、涨停收盘≥20日高×0.95、首阴实体0.05~8%', pass: (m) => n(m.volRatio) >= 1.5 && n(m.nearHighPct) >= 95 && n(m.body1) >= 0.05 && n(m.body1) <= 8 },
  { name: 'vol0', note: '不卡放量', pass: (m) => n(m.nearHighPct) >= 95 && n(m.body1) >= 0.05 && n(m.body1) <= 8 },
  { name: 'vol10', note: '放量≥1.0', pass: (m) => n(m.volRatio) >= 1.0 && n(m.nearHighPct) >= 95 && n(m.body1) >= 0.05 && n(m.body1) <= 8 },
  { name: 'vol20', note: '放量≥2.0', pass: (m) => n(m.volRatio) >= 2.0 && n(m.nearHighPct) >= 95 && n(m.body1) >= 0.05 && n(m.body1) <= 8 },
  { name: 'nearHigh0', note: '不卡近新高', pass: (m) => n(m.volRatio) >= 1.5 && n(m.body1) >= 0.05 && n(m.body1) <= 8 },
  { name: 'nearHigh100', note: '涨停收盘创 20 日新高', pass: (m) => n(m.volRatio) >= 1.5 && n(m.nearHighPct) >= 100 && n(m.body1) >= 0.05 && n(m.body1) <= 8 },
  { name: 'body5', note: '首阴实体上限 5%', pass: (m) => n(m.volRatio) >= 1.5 && n(m.nearHighPct) >= 95 && n(m.body1) >= 0.05 && n(m.body1) <= 5 },
  { name: 'body12', note: '首阴实体上限 12%', pass: (m) => n(m.volRatio) >= 1.5 && n(m.nearHighPct) >= 95 && n(m.body1) >= 0.05 && n(m.body1) <= 12 },
];

// ============================ 输出 ============================

/** 变体选行：有 key 的策略（双龙回踩）按组取「最早命中」的一行，避免同一二板重复计样本 */
function selectRows(rows: Row[], pass: (m: any) => boolean): Row[] {
  if (!rows.length || rows[0].key === undefined) return rows.filter((r) => pass(r.m));
  const best = new Map<string, Row>();
  for (const r of rows) {
    if (!pass(r.m)) continue;
    const k = r.key as string;
    const cur = best.get(k);
    if (!cur || Number(r.m.offset) < Number(cur.m.offset)) best.set(k, r);
  }
  return [...best.values()];
}

function summarize(rows: Row[], variants: Variant[]): string[] {
  const out: string[] = [];
  for (const v of variants) {
    const sel = selectRows(rows, v.pass);
    const ex924 = sel.filter((r) => !r.inWin);
    const strict = sel.filter((r) => !r.ov);
    const fmt = (rs: Row[]) => {
      const h = stats(rs.map((r) => r.rHigh));
      const o = stats(rs.map((r) => r.rOpen));
      const c5 = stats(rs.map((r) => r.r5Cum));
      return `n=${h.n} high[win${h.win}/avg${h.avg}/>2%${gt2(rs.map((r) => r.rHigh))}] open[win${o.win}/avg${o.avg}] t5cum[win${c5.win}/avg${c5.avg}/>2%${gt2(rs.map((r) => r.r5Cum))}]`;
    };
    out.push(`  ${v.name.padEnd(14)} all: ${fmt(sel)}`);
    out.push(`  ${''.padEnd(14)} ex924: ${fmt(ex924)}`);
    out.push(`  ${''.padEnd(14)} strict: ${fmt(strict)}`);
  }
  return out;
}

function byYear(rows: Row[], pass: (m: any) => boolean): Record<string, any> {
  const sel = selectRows(rows, pass).filter((r) => !r.inWin);
  const ys = [...new Set(sel.map((r) => r.year))].sort();
  const out: Record<string, any> = {};
  for (const y of ys) {
    const rs = sel.filter((r) => r.year === y);
    const h = stats(rs.map((r) => r.rHigh));
    const o = stats(rs.map((r) => r.rOpen));
    out[y] = { n: rs.length, highWin: h.win, highAvg: h.avg, openWin: o.win, openAvg: o.avg };
  }
  return out;
}

function windowReport(rows: Row[]): string {
  const inWin = rows.filter((r) => r.inWin);
  if (!inWin.length) return '  924 窗口内样本 0';
  const h = stats(inWin.map((r) => r.rHigh));
  const o = stats(inWin.map((r) => r.rOpen));
  return `  924 窗口内样本 n=${inWin.length} high[win${h.win}/avg${h.avg}] open[win${o.win}/avg${o.avg}]`;
}

function selfTest(): void {
  const m: Record<string, any> = {
    maxBody: 3, trueYin2: true, trueYin3: true, volDec: true, volShrink: true,
    boardCount: 4, minChangeTurnover: 9, bodyPct: 4, volumeRatio: 1.5, turnoverRate: 12,
    atLimitDown: false, fakeYin: true, isWash: false, quality: 'turnover',
    body1: 6, breakout60: true, volRatio1: 2, secondOneWord: false,
    offset: 1, touchPct: 1,
    nearHighPct: 98,
  };
  const sets: [string, Variant[]][] = [
    ['板三阴', SY_VARIANTS], ['龙首阴', DFY_VARIANTS], ['双龙打板', DDB_VARIANTS],
    ['龙四阴', D4_VARIANTS],
  ];
  for (const [name, vs] of sets) {
    console.log('## ' + name);
    for (const v of vs) console.log(' ', v.name, '=>', v.pass(m));
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) { selfTest(); return; }
  const yearsArg = args.find((a) => a.startsWith('--years='));
  const years = yearsArg ? yearsArg.slice('--years='.length).split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_YEARS;
  const noPrefilter = args.includes('--noprefilter');

  const latestRow = await prisma.dailyBar.findFirst({ orderBy: { tradeDate: 'desc' }, select: { tradeDate: true } });
  if (!latestRow) throw new Error('no daily bars');
  const latestDate = latestRow.tradeDate;

  const acc = emptyAcc();
  const t0 = Date.now();
  for (const year of years) {
    const loadStart = `${Number(year) - 1}0901`;
    const rawEnd = `${Number(year) + 1}0110`;
    const loadEnd = rawEnd < latestDate ? rawEnd : latestDate;
    const tq = Date.now();
    const codes = noPrefilter ? null : (await loadCandidateCodes(loadStart, loadEnd)).map((r) => r.tsCode);
    const raw = await loadBars(codes, loadStart, loadEnd);
    processRaw(raw, year, acc);
    console.log(`[chunk] ${year} window ${loadStart}~${loadEnd} codes=${codes ? codes.length : 'ALL'} rows=${raw.length} ` +
      `(sql+load ${Date.now() - tq}ms) ` +
      `sy=${acc.sy.length} dfy=${acc.dfy.length} ddB=${acc.ddBoard.length} d4=${acc.d4.length} ` +
      `elapsed=${Date.now() - t0}ms`);
  }

  const blocks: [string, Row[], Variant[], Variant | null][] = [
    ['策略一 板三阴（买点=第三阴收盘，主退出=次日最高）', acc.sy, SY_VARIANTS, SY_VARIANTS[0]],
    ['策略二 龙首阴（买点=首阴收盘，主退出=次日最高）', acc.dfy, DFY_VARIANTS, DFY_VARIANTS[0]],
    ['策略三 双龙·二板打板（买点=二板涨停价，主退出=第三日开盘）', acc.ddBoard, DDB_VARIANTS, DDB_VARIANTS[0]],
    ['策略四 龙四阴（买点=第4阴收盘，主退出=次日最高）', acc.d4, D4_VARIANTS, D4_VARIANTS[0]],
  ];

  for (const [title, rows, variants, baseV] of blocks) {
    console.log('\n================================================================');
    console.log(title);
    console.log('================================================================');
    const baseRows = baseV ? selectRows(rows, baseV.pass) : rows;
    console.log(windowReport(baseRows));
    console.log('结构信号总数 n=' + baseRows.length + '（已剔除 T+5 不完整样本）');
    for (const line of summarize(rows, variants)) console.log(line);
    if (baseV) {
      console.log('\n  base 变体逐年（剔924，n/T+1最高胜率/T+1最高均值/T+1开盘胜率）：');
      console.log('  ' + JSON.stringify(byYear(rows, baseV.pass)));
    }
  }

  console.log('\ntotal elapsed', Date.now() - t0, 'ms');
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
