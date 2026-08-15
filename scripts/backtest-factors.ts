/**
 * 全市场因子回测 — 历史重估 AI 筛选因子 / 做T日级因子 / 原始信号的预测力
 *
 * 目的：把"拍脑袋"的因子权重/曲线换成数据推导。输出 IC 报告 + 权重建议，供人拍板后再改生产配置。
 *
 * 口径对齐（逐字复刻生产，任何偏差都会让结论失真）：
 *   候选池  : 复刻 services/ai-screen/candidates.ts fetchCandidates(preset)
 *             —— SQL 硬筛(ST/RPS/成交额/价格/涨跌幅/60日涨幅) + ORDER BY rps DESC LIMIT 200
 *               + TS 侧技术硬筛(波动率/回撤/MA多头, enrich 内)
 *   因子分  : 直接调用 services/ai-screen/scorer.ts computeScreenScores（7 因子全算）
 *   前向收益: 复刻 scripts/backfill-ai-screen-eval.ts —— 全局交易日序列(dayIndex 偏移)，
 *             entry = close(D)，exit = close(D+N)（N=1/5/20），停牌/缺bar 的观测跳过
 *   做T因子 : 镜像 services/t-score/scorer.ts 的 buyDailyTrend / sellDailyOverheat（私有函数本地复刻，
 *             参数直接用 DEFAULT_TSCORE_PROFILE）
 *
 * 已知偏差（报告 meta 中也会标注）：
 *   - ST 过滤用 stocks 表当前名称（历史 ST 状态未知 → 轻微选择偏差）
 *   - quality 因子用当前基本面快照（未来函数！权重推导应排除 quality）
 *   - 行业归属用当前成分股（theme_heat 轻微 lookahead）
 *   - 候选池 LIMIT 200 上限保留（与生产一致，避免高估 IC 样本量）
 *   - 分钟级因子（做T的 5/15 分 K）无历史数据，不可回测，仍维持暂行权重
 *   - 2026-08-10 起价格序列为后复权（×adj_factor）；回补未完成期间缺失因子退化为原始价
 *
 * 运行：npx tsx scripts/backtest-factors.ts [--presets=momentum,balanced]
 * 输出：backtest-report.md + backtest-report.json（写到 cwd）
 */

import { writeFileSync } from 'fs';
import { prisma } from '../lib/db';
import { STRATEGY_PRESETS } from '../services/ai-screen/strategies';
import { computeScreenScores } from '../services/ai-screen/scorer';
import { computeChipDistribution } from '../lib/chip';
import { calculateMA, calculateEMA, calcRSISeries } from '../lib/indicators';
import { DEFAULT_TSCORE_PROFILE } from '../services/t-score/scorer';

const NS = [1, 5, 20];
const MAX_N = 20;
const LOOKBACK = 65; // 筹码峰 60 主窗 + 5 漂移窗
const MIN_POOL = 15; // 单日 IC 最少配对观测
const POOL_LIMIT = 200;
const MARKET_MIN = 200;
const RPS_COLS: Record<number, string> = { 20: 'rps_20', 60: 'rps_60', 120: 'rps_120', 250: 'rps_250' };

// ===================== 数据装载 =====================

/** 每只股票的紧凑时序存储（全局交易日下标 + 字段 Float64Array，省内存） */
interface StockData {
  code: string;
  gi: Uint16Array; // 全局交易日下标（升序）
  close: Float64Array;
  high: Float64Array;
  low: Float64Array;
  vol: Float64Array;
  amount: Float64Array;   // 千元
  change: Float64Array;   // 当日涨跌幅 %
  turnover: Float64Array; // 换手率 %
}

/** 二分查找全局下标 g 在股票序列中的本地下标，不存在返回 -1 */
function findLocalIdx(s: StockData, g: number): number {
  const gi = s.gi;
  let lo = 0, hi = gi.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = gi[mid];
    if (v === g) return mid;
    if (v < g) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

interface DayFeatures {
  volatility20d: number | null;
  maxDrawdown20d: number | null;
  atr20: number | null;
  volumeRatio: number | null;
  maBullish: boolean | null;
  macdStatus: 'bullish' | 'bearish' | 'neutral';
  rsi14: number | null;
  rsiStatus: string;
  pullbackToMa20Pct: number | null;
  breakout20dPct: number | null;
  chipConcentration: number | null;
  chipProfitRatio: number | null;
  chipPeakPos: number | null;
  chipPeakDrift: number | null;
}

// —— 以下 10 个函数逐字镜像 services/ai-screen/indicators.ts（直接拷贝，防口径漂移） ——
function ema(values: number[], span: number): number[] {
  const out = new Array(values.length).fill(null) as number[];
  if (values.length === 0) return out;
  const alpha = 2 / (span + 1);
  let prev = values[0];
  out[0] = prev;
  for (let i = 1; i < values.length; i++) {
    prev = alpha * values[i] + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}
function maSeries(values: number[], period: number): number[] {
  const out = new Array(values.length).fill(null) as number[];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}
function macdStatus(closes: number[]): string {
  if (closes.length < 35) return 'neutral';
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const dif = closes.map((_, i) => (ema12[i] != null && ema26[i] != null ? ema12[i]! - ema26[i]! : null));
  const dea = ema(dif.map((v) => v ?? 0), 9);
  const n = closes.length;
  const dNow = dif[n - 1], dPrev = dif[n - 2], eNow = dea[n - 1], ePrev = dea[n - 2];
  if (dNow == null || dPrev == null || eNow == null || ePrev == null) return 'neutral';
  if (dPrev <= ePrev && dNow > eNow) return 'bullish';
  if (dPrev >= ePrev && dNow < eNow) return 'bearish';
  return dNow > eNow ? 'bullish' : dNow < eNow ? 'bearish' : 'neutral';
}
function rsi(closes: number[], period: number): number | null {
  if (closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gain += ch; else loss -= ch;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = ch > 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}
function rsiStatus(closes: number[]): string {
  const v = rsi(closes, 14);
  if (v == null) return 'neutral';
  if (v < 30) return 'oversold';
  if (v > 70) return 'overbought';
  return 'neutral';
}
function volatility20d(closes: number[]): number | null {
  if (closes.length < 21) return null;
  const rets: number[] = [];
  for (let i = closes.length - 20; i < closes.length; i++) {
    if (closes[i - 1] > 0) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  if (rets.length < 2) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(20) * 100;
}
function maxDrawdown20d(closes: number[]): number | null {
  if (closes.length < 2) return null;
  const start = Math.max(0, closes.length - 20);
  const slice = closes.slice(start);
  let peak = slice[0], maxDd = 0;
  for (const c of slice) {
    if (c > peak) peak = c;
    const dd = (c - peak) / peak;
    if (dd < maxDd) maxDd = dd;
  }
  return maxDd * 100;
}
function atr20pct(closes: number[], highs: number[], lows: number[]): number | null {
  const n = closes.length;
  if (n < 21) return null;
  const trs: number[] = [];
  for (let i = n - 20; i < n; i++) {
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    trs.push(tr);
  }
  const atr = trs.reduce((a, b) => a + b, 0) / trs.length;
  const lastClose = closes[n - 1];
  if (!lastClose) return null;
  return (atr / lastClose) * 100;
}
function volumeRatio(vols: number[]): number | null {
  if (vols.length < 21) return null;
  const last = vols[vols.length - 1];
  const slice = vols.slice(vols.length - 21, vols.length - 1);
  const avg = slice.reduce((a, b) => a + b, 0) / slice.length;
  if (!avg) return null;
  return last / avg;
}
function maBullish(closes: number[]): boolean | null {
  if (closes.length < 55) return null;
  const ma5 = maSeries(closes, 5), ma13 = maSeries(closes, 13), ma55 = maSeries(closes, 55);
  const n = closes.length - 1;
  if (ma5[n] == null || ma13[n] == null || ma55[n] == null) return null;
  return ma5[n]! > ma13[n]! && ma13[n]! > ma55[n]!;
}
function pullbackToMa20Pct(closes: number[]): number | null {
  if (closes.length < 20) return null;
  const ma20 = maSeries(closes, 20);
  const n = closes.length - 1;
  const m = ma20[n], last = closes[n];
  if (m == null || !m || !last) return null;
  return ((last - m) / m) * 100;
}
function breakout20dPct(closes: number[], highs: number[]): number | null {
  const n = closes.length;
  if (n < 2 || highs.length !== n) return null;
  const start = Math.max(0, n - 20);
  let hi = -Infinity;
  for (let i = start; i < n - 1; i++) hi = Math.max(hi, highs[i]);
  if (!Number.isFinite(hi) || hi <= 0) return null;
  return ((closes[n - 1] - hi) / hi) * 100;
}

/** 单日特征（含筹码 4 维；withChip=false 时跳过 chip 计算 —— 全市场段省算力） */
function computeFeatures(s: StockData, li: number, withChip: boolean): DayFeatures {
  const start = Math.max(0, li - 64);
  const closes = Array.from(s.close.slice(start, li + 1));
  const highs = Array.from(s.high.slice(start, li + 1));
  const lows = Array.from(s.low.slice(start, li + 1));
  const vols = Array.from(s.vol.slice(start, li + 1));
  const f: DayFeatures = {
    volatility20d: volatility20d(closes),
    maxDrawdown20d: maxDrawdown20d(closes),
    atr20: atr20pct(closes, highs, lows),
    volumeRatio: volumeRatio(vols),
    maBullish: maBullish(closes),
    macdStatus: macdStatus(closes) as DayFeatures['macdStatus'],
    rsi14: rsi(closes, 14),
    rsiStatus: rsiStatus(closes),
    pullbackToMa20Pct: pullbackToMa20Pct(closes),
    breakout20dPct: breakout20dPct(closes, highs),
    chipConcentration: null, chipProfitRatio: null, chipPeakPos: null, chipPeakDrift: null,
  };
  if (withChip) {
    const n = Math.min(closes.length, highs.length, lows.length, vols.length);
    const bars: { high: number; low: number; close: number; vol: number; turnoverRate: number | null }[] = [];
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(closes[i]) || !Number.isFinite(highs[i]) || !Number.isFinite(lows[i])) continue;
      bars.push({ high: highs[i], low: lows[i], close: closes[i], vol: vols[i] ?? 0, turnoverRate: s.turnover[start + i] != null ? s.turnover[start + i] : null });
    }
    const chip = computeChipDistribution(bars as any, s.close[li]);
    if (chip) {
      f.chipConcentration = chip.concentration90;
      f.chipProfitRatio = chip.profitRatio;
      f.chipPeakPos = chip.peakPos;
      let drift: number | null = null;
      if (bars.length > 60) {
        const prevBars = bars.slice(bars.length - 65, bars.length - 5);
        const prevPrice = prevBars[prevBars.length - 1]?.close ?? s.close[li];
        const prev = computeChipDistribution(prevBars as any, prevPrice);
        if (prev) drift = (chip.dominantPeak - prev.dominantPeak) / chip.avgCost;
      }
      f.chipPeakDrift = drift != null ? Math.round(drift * 1000) / 1000 : null;
    }
  }
  return f;
}

// ===================== 做T日级因子（镜像 t-score/scorer.ts 私有函数） =====================

function tMacdStatus(closes: number[]): string {
  if (closes.length < 35) return 'neutral';
  const ema12 = calculateEMA(closes, 12);
  const ema26 = calculateEMA(closes, 26);
  const n = closes.length;
  const dif = closes.map((_, i) => (Number.isNaN(ema12[i]) || Number.isNaN(ema26[i]) ? NaN : ema12[i] - ema26[i]));
  const dea = calculateEMA(dif, 9);
  const dNow = dif[n - 1], dPrev = dif[n - 2], eNow = dea[n - 1], ePrev = dea[n - 2];
  if (Number.isNaN(dNow) || Number.isNaN(dPrev) || Number.isNaN(eNow) || Number.isNaN(ePrev)) return 'neutral';
  if (dPrev <= ePrev && dNow > eNow) return 'bullish';
  if (dPrev >= ePrev && dNow < eNow) return 'bearish';
  return dNow > eNow ? 'bullish' : dNow < eNow ? 'bearish' : 'neutral';
}
function tMaBullish(closes: number[]): boolean | null {
  if (closes.length < 55) return null;
  const ma5 = calculateMA(closes, 5), ma13 = calculateMA(closes, 13), ma55 = calculateMA(closes, 55);
  const n = closes.length - 1;
  if (Number.isNaN(ma5[n]) || Number.isNaN(ma13[n]) || Number.isNaN(ma55[n])) return null;
  if (ma5[n] > ma13[n] && ma13[n] > ma55[n]) return true;
  return false;
}
function tRsiStatus(closes: number[]): string {
  const series = calcRSISeries(closes, 14);
  const v = series[series.length - 1];
  if (v == null || Number.isNaN(v)) return 'neutral';
  if (v < 30) return 'oversold';
  if (v > 70) return 'overbought';
  return 'neutral';
}
const clip = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

/** 买·日级趋势（t-score 因子，权重 0.11） */
function buyDailyTrend(closes: number[], p: Record<string, number>): number {
  const mab = tMaBullish(closes);
  const macd = tMacdStatus(closes);
  let trendComp = p.buy_trend_base;
  if (mab === true) trendComp += p.buy_trend_ma_bullish_bonus;
  else if (mab === false) trendComp -= p.buy_trend_ma_bearish_penalty;
  if (macd === 'bullish') trendComp += p.buy_trend_macd_bullish_bonus;
  else if (macd === 'bearish') trendComp -= p.buy_trend_macd_bearish_penalty;
  trendComp = clip(trendComp);

  const pb = pullbackToMa20Pct(closes);
  let pullbackComp = 50;
  if (pb != null) {
    pullbackComp = 100 - Math.abs(pb - p.buy_daily_pullback_ideal) * p.buy_daily_pullback_slope;
    if (pb < p.buy_daily_pullback_breakdown) pullbackComp = Math.min(pullbackComp, p.buy_daily_pullback_breakdown_cap);
  }
  return clip(0.5 * trendComp + 0.5 * clip(pullbackComp));
}

/** 卖·日级过热（t-score 因子，权重 0.11；chip 参数全市场段传 null） */
function sellDailyOverheat(closes: number[], highs: number[], chipPeakPos: number | null, p: Record<string, number>): number {
  let s = p.sell_overheat_base;
  const rs = tRsiStatus(closes);
  if (rs === 'overbought') s += p.sell_overheat_rsi_overbought_bonus;
  else if (rs === 'oversold') s -= p.sell_overheat_rsi_oversold_penalty;

  const bo = breakout20dPct(closes, highs);
  if (bo != null && bo >= 0) s += p.sell_overheat_breakout_bonus;
  if (chipPeakPos != null && chipPeakPos > 0.1) s += p.sell_overheat_chip_above_peak_bonus;

  const pb = pullbackToMa20Pct(closes);
  if (pb != null && pb < -5) s -= p.sell_overheat_far_below_ma_penalty;
  return clip(s);
}

// ===================== 统计工具 =====================

function rankify(vals: number[]): number[] {
  const idx = vals.map((v, i) => [v, i] as [number, number]).sort((a, b) => a[0] - b[0]);
  const ranks = new Array(vals.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[idx[k][1]] = avg;
    i = j + 1;
  }
  return ranks;
}

/** 配对 Spearman 秩相关（逐日 IC 用），两数组需已按索引对齐 */
function spearman(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < MIN_POOL) return null;
  const rx = rankify(xs), ry = rankify(ys);
  const mx = rx.reduce((a, b) => a + b, 0) / n, my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const xd = rx[i] - mx, yd = ry[i] - my;
    num += xd * yd;
    dx += xd * xd;
    dy += yd * yd;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

interface IcStats { n: number; mean: number; std: number; icir: number; t: number; posPct: number; is: { n: number; mean: number } | null; oos: { n: number; mean: number } | null }

function icStats(ics: number[], splitIdx: number): IcStats {
  const n = ics.length;
  const mean = ics.reduce((a, b) => a + b, 0) / n;
  const std = n > 1 ? Math.sqrt(ics.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const seg = (from: number, to: number) => {
    const s = ics.slice(from, to);
    if (s.length === 0) return null;
    return { n: s.length, mean: s.reduce((a, b) => a + b, 0) / s.length };
  };
  return {
    n, mean, std,
    icir: std > 0 ? mean / std : 0,
    t: std > 0 ? mean / (std / Math.sqrt(n)) : 0,
    posPct: (ics.filter((v) => v > 0).length / n) * 100,
    is: seg(0, splitIdx),
    oos: seg(splitIdx, ics.length),
  };
}

// ===================== 主流程 =====================

interface Obs {
  day: string;
  month: string;
  factors: Record<string, number>;
  raw: Record<string, number>;
  rets: (number | null)[];
  screenCurrent: number;
}

const fmtPct = (v: number | null | undefined, digits = 2) => v == null ? '-' : `${(v * 100).toFixed(digits)}%`;
const fmtNum = (v: number | null | undefined, digits = 3) => v == null ? '-' : v.toFixed(digits);

async function main() {
  const presetsArg = process.argv.find((a) => a.startsWith('--presets='))?.split('=')[1];
  const presets = presetsArg
    ? STRATEGY_PRESETS.filter((s) => presetsArg.split(',').includes(s.id))
    : STRATEGY_PRESETS.filter((s) => s.id === 'momentum' || s.id === 'balanced');
  console.log(`[backtest] 策略: ${presets.map((s) => s.id).join(', ')}`);

  // 1. 全局交易日序列
  const days = await prisma.$queryRawUnsafe<{ tradeDate: string }[]>(
    `SELECT DISTINCT "tradeDate" FROM daily_bars ORDER BY "tradeDate" ASC`
  );
  const globalDays = days.map((d) => d.tradeDate);
  const giMap = new Map(globalDays.map((d, i) => [d, i]));
  console.log(`[backtest] 交易日 ${globalDays.length} 天: ${globalDays[0]} ~ ${globalDays[globalDays.length - 1]}`);

  // 2. RPS 覆盖日 + 基本面快照
  const rpsRows: { calcDate: string }[] = await prisma.$queryRawUnsafe(`SELECT DISTINCT "calcDate" FROM rps_scores`);
  const rpsDates = new Set(rpsRows.map((r) => r.calcDate));
  console.log(`[backtest] RPS 覆盖 ${rpsDates.size} 天`);
  const fundRows: { ts_code: string; roe: number | null; grossprofit_margin: number | null; or_yoy: number | null }[] = await prisma.$queryRawUnsafe(
    `SELECT ts_code, roe, grossprofit_margin, or_yoy FROM stock_fundamentals`
  );
  const fundamentals = new Map(fundRows.map((r) => [r.ts_code, r]));
  console.log(`[backtest] 基本面快照 ${fundamentals.size} 条（quality 因子=未来函数，报告标注）`);

  // 3. 批量装载日线（按日期分块，控制内存；先用普通数组收集，装完再转紧凑类型）
  interface StockBuf {
    code: string;
    gi: number[]; close: number[]; high: number[]; low: number[];
    vol: number[]; amount: number[]; change: number[]; turnover: number[];
  }
  const bufMap = new Map<string, StockBuf>();
  const CHUNK = 30;
  for (let c = 0; c < globalDays.length; c += CHUNK) {
    const lo = globalDays[c], hi = globalDays[Math.min(c + CHUNK - 1, globalDays.length - 1)];
    const rows: any[] = await prisma.$queryRawUnsafe(
      // 后复权口径：OHLC × adj_factor（因子缺失退化为原始价）。特征/筹码/T+N收益全部由同一
      // 序列内部自洽（比率为不变量），消除除权假跳空污染；vol/amount/turnover/change_pct 原始透传
      `SELECT "tsCode", "tradeDate",
              close * COALESCE(adj_factor, 1) AS close,
              high * COALESCE(adj_factor, 1) AS high,
              low  * COALESCE(adj_factor, 1) AS low,
              vol, amount, change_pct, turnover_rate
       FROM daily_bars WHERE "tradeDate" >= $1 AND "tradeDate" <= $2 ORDER BY "tradeDate"`,
      lo, hi
    );
    for (const r of rows) {
      const g = giMap.get(r.tradeDate);
      if (g == null) continue;
      let s = bufMap.get(r.tsCode);
      if (!s) {
        s = { code: r.tsCode, gi: [], close: [], high: [], low: [], vol: [], amount: [], change: [], turnover: [] };
        bufMap.set(r.tsCode, s);
      }
      s.gi.push(g);
      s.close.push(r.close);
      s.high.push(r.high);
      s.low.push(r.low);
      s.vol.push(r.vol);
      s.amount.push(r.amount);
      s.change.push(r.change_pct);
      s.turnover.push(r.turnover_rate ?? NaN);
    }
    if ((c / CHUNK + 1) % 5 === 0) console.log(`[backtest] 装载 ${Math.min(c + CHUNK, globalDays.length)}/${globalDays.length} 天, ${bufMap.size} 只`);
  }
  const stockMap = new Map<string, StockData>();
  for (const [code, b] of bufMap) {
    stockMap.set(code, {
      code,
      gi: new Uint16Array(b.gi),
      close: new Float64Array(b.close),
      high: new Float64Array(b.high),
      low: new Float64Array(b.low),
      vol: new Float64Array(b.vol),
      amount: new Float64Array(b.amount),
      change: new Float64Array(b.change),
      turnover: new Float64Array(b.turnover),
    });
  }
  console.log(`[backtest] 日线装载完成: ${stockMap.size} 只股票`);

  // 4. 评估窗口: 需要 LOOKBACK 历史 + T+20 未来
  const evalDays: { idx: number; day: string }[] = [];
  for (let i = LOOKBACK + 5; i < globalDays.length - MAX_N; i++) {
    if (rpsDates.has(globalDays[i])) evalDays.push({ idx: i, day: globalDays[i] });
  }
  console.log(`[backtest] 评估日 ${evalDays.length} 天: ${evalDays[0]?.day} ~ ${evalDays[evalDays.length - 1]?.day}`);
  const splitIdx = Math.floor(evalDays.length * 0.7);

  // ===================== 5. 策略池回放 =====================

  const poolResults: Record<string, { obs: Obs[]; dayStats: Map<string, { poolMean5: number; marketMean5: number; top20Cur5: number; n: number; nMarket: number }> }> = {};

  for (const preset of presets) {
    console.log(`\n[backtest] ==== 策略 ${preset.id} 回放 ====`);
    const hf = preset.hardFilters;
    const rpsCol = RPS_COLS[hf.rpsPeriod ?? 60] ?? 'rps_60';
    const obsArr: Obs[] = [];
    const dayStats = new Map<string, { poolMean5: number; marketMean5: number; top20Cur5: number; n: number; nMarket: number }>();

    for (let e = 0; e < evalDays.length; e++) {
      const { idx: dayIdx, day } = evalDays[e];
      // 候选池 SQL（镜像 fetchCandidates：硬筛 + LIMIT 200）
      const where: string[] = [`s.name NOT ILIKE '%ST%'`];
      const params: any[] = [day];
      if (hf.rpsMin != null) { params.push(hf.rpsMin); where.push(`r.${rpsCol} >= $${params.length}`); }
      if (hf.rpsMax != null) { params.push(hf.rpsMax); where.push(`r.${rpsCol} <= $${params.length}`); }
      if (hf.amountMin != null) { params.push(hf.amountMin); where.push(`db.amount * 1000 >= $${params.length}`); }
      if (hf.priceMin != null) { params.push(hf.priceMin); where.push(`db.close >= $${params.length}`); }
      if (hf.priceMax != null) { params.push(hf.priceMax); where.push(`db.close <= $${params.length}`); }
      if (hf.changePctMin != null) { params.push(hf.changePctMin); where.push(`db.change_pct >= $${params.length}`); }
      if (hf.changePctMax != null) { params.push(hf.changePctMax); where.push(`db.change_pct <= $${params.length}`); }
      if (hf.change60dMin != null) { params.push(hf.change60dMin); where.push(`r.ret_60 >= $${params.length}`); }
      if (hf.change60dMax != null) { params.push(hf.change60dMax); where.push(`r.ret_60 <= $${params.length}`); }
      const rows: any[] = await prisma.$queryRawUnsafe(
        `SELECT s.ts_code, s.name, r.${rpsCol} AS rps, r.ret_60 AS ret60d,
                db.close, db.change_pct, db.vol, db.amount, ind.pct_chg AS industry_change_pct
         FROM stocks s
         JOIN rps_scores r ON r."tsCode" = s.ts_code AND r."calcDate" = $1
         JOIN daily_bars db ON db."tsCode" = s.ts_code AND db."tradeDate" = $1
         LEFT JOIN LATERAL (SELECT m.index_code FROM sw_index_member m WHERE m.member_code = s.ts_code AND m.index_level = 'L1' LIMIT 1) m ON true
         LEFT JOIN sw_index_daily ind ON ind.ts_code = m.index_code AND ind.trade_date = $1
         WHERE ${where.join(' AND ')}
         ORDER BY r.${rpsCol} DESC NULLS LAST
         LIMIT ${POOL_LIMIT}`,
        ...params
      );

      // enrich（TS 侧技术硬筛）+ 组装打分输入
      const picks: any[] = [];
      const pickMeta: { stock: StockData; li: number; close: number }[] = [];
      for (const row of rows) {
        const stock = stockMap.get(row.ts_code);
        if (!stock) continue;
        const li = findLocalIdx(stock, dayIdx);
        if (li < 0) continue;
        const f = computeFeatures(stock, li, true);
        if (hf.volumeRatioMax != null && f.volumeRatio != null && f.volumeRatio > hf.volumeRatioMax) continue;
        if (hf.volatility20dPctMax != null && f.volatility20d != null && f.volatility20d > hf.volatility20dPctMax) continue;
        if (hf.maxDrawdown20dPctMin != null && f.maxDrawdown20d != null && f.maxDrawdown20d < hf.maxDrawdown20dPctMin) continue;
        if (hf.requireMaBullish && f.maBullish !== true) continue;
        const fund = fundamentals.get(row.ts_code);
        picks.push({
          tsCode: row.ts_code, name: row.name, industry: null,
          rps: row.rps != null ? Number(row.rps) : null,
          latestChange: row.change_pct != null ? Number(row.change_pct) : null,
          ret60d: row.ret60d != null ? Number(row.ret60d) : null,
          maBullish: f.maBullish, macdStatus: f.macdStatus, volumeRatio: f.volumeRatio,
          latestAmount: row.amount != null ? Number(row.amount) * 1000 : null,
          pullbackToMa20Pct: f.pullbackToMa20Pct, rsiStatus: f.rsiStatus, rsi14: f.rsi14,
          volatility20d: f.volatility20d, maxDrawdown20d: f.maxDrawdown20d, atr20: f.atr20,
          industryChangePct: row.industry_change_pct != null ? Number(row.industry_change_pct) : null,
          chipConcentration: f.chipConcentration, chipProfitRatio: f.chipProfitRatio,
          chipPeakPos: f.chipPeakPos, chipPeakDrift: f.chipPeakDrift,
          roe: fund?.roe ?? null, grossprofitMargin: fund?.grossprofit_margin ?? null, orYoy: fund?.or_yoy ?? null,
          factorScores: {}, screenScore: 0,
        });
        pickMeta.push({ stock, li, close: stock.close[li] }); // 收益基准取后复权序列内值，与 exit 端同口径（row.close 为原始价，仅价格硬筛用）
      }

      computeScreenScores(picks, preset);

      // 前向收益（复刻 backfill-ai-screen-eval：全局 dayIdx + N）
      const obs: Obs[] = [];
      for (let i = 0; i < picks.length; i++) {
        const rets: (number | null)[] = [];
        for (const N of NS) {
          const exitIdx = dayIdx + N;
          if (exitIdx >= globalDays.length) { rets.push(null); continue; }
          const li = findLocalIdx(pickMeta[i].stock, exitIdx);
          const c = li >= 0 ? pickMeta[i].stock.close[li] : NaN;
          rets.push(Number.isFinite(c) && c > 0 ? c / pickMeta[i].close - 1 : null);
        }
        const pk = picks[i];
        const raw: Record<string, number> = {
          rps60: pk.rps ?? NaN, ret60d: pk.ret60d ?? NaN,
          change: pk.latestChange ?? NaN,
          vol20: pk.volatility20d ?? NaN, dd20: pk.maxDrawdown20d ?? NaN, atr20: pk.atr20 ?? NaN,
          vr: pk.volumeRatio ?? NaN, pullback: pk.pullbackToMa20Pct ?? NaN, breakout: pk.breakout20dPct ?? NaN,
          rsi14: pk.rsi14 ?? NaN, ind: pk.industryChangePct ?? NaN,
          chipConc: pk.chipConcentration ?? NaN, chipProfit: pk.chipProfitRatio ?? NaN,
          chipPeak: pk.chipPeakPos ?? NaN, chipDrift: pk.chipPeakDrift ?? NaN,
        };
        obs.push({ day, month: day.slice(0, 6), factors: { ...pk.factorScores }, raw, rets, screenCurrent: pk.screenScore });
      }
      obsArr.push(...obs);

      // 当日市场均值(T+5) —— 用于池 vs 市场基线
      let marketMean5 = NaN, nMarket = 0;
      for (const stock of stockMap.values()) {
        const li = findLocalIdx(stock, dayIdx);
        if (li < 0) continue;
        const eli = findLocalIdx(stock, dayIdx + 5);
        if (eli < 0) continue;
        const r = stock.close[eli] / stock.close[li] - 1;
        marketMean5 = Number.isFinite(marketMean5) ? marketMean5 + r : r;
        nMarket++;
      }
      if (nMarket > 0) marketMean5 /= nMarket;

      // 池均值 与 当前权重 top20 的 T+5 均值
      const sorted = [...obs].sort((a, b) => b.screenCurrent - a.screenCurrent);
      const topCur = sorted.slice(0, 20).filter((o) => o.rets[1] != null);
      const top20Cur5 = topCur.length ? topCur.reduce((a, o) => a + o.rets[1]!, 0) / topCur.length : NaN;
      const pool5 = obs.filter((o) => o.rets[1] != null);
      const poolMean5 = pool5.length ? pool5.reduce((a, o) => a + o.rets[1]!, 0) / pool5.length : NaN;

      dayStats.set(day, { poolMean5, marketMean5, top20Cur5, n: picks.length, nMarket });
      if ((e + 1) % 50 === 0) console.log(`[backtest] ${preset.id} 回放 ${e + 1}/${evalDays.length} 天, 当日池 ${picks.length} 只`);
    }
    poolResults[preset.id] = { obs: obsArr, dayStats };
    console.log(`[backtest] ${preset.id} 完成: ${obsArr.length} 条观测`);
  }

  // ===================== 6. 全市场段（原始信号 + 做T日级因子 IC） =====================

  console.log(`\n[backtest] ==== 全市场段 ====`);
  const marketSeries: Record<string, number[]> = {};
  const marketNames: Record<string, string> = {
    change_pct: '当日涨幅', volatility20d: '20日波动率', maxDrawdown20d: '20日最大回撤', atr20: 'ATR20%',
    volumeRatio: '量比', pullbackToMa20Pct: '距MA20回踩%', breakout20dPct: '突破20日高%', rsi14: 'RSI14',
    maBullish: 'MA多头(0/1)', macdBull: 'MACD多头(0/1)', macdBear: 'MACD空头(0/1)', logAmount: 'log成交额',
    tscore_buyDailyTrend: '做T·日级趋势', tscore_sellOverheat: '做T·日级过热',
  };
  const p = DEFAULT_TSCORE_PROFILE;

  for (let e = 0; e < evalDays.length; e++) {
    const { idx: dayIdx } = evalDays[e];
    // 先算每只股票的 T+5 收益，再按信号收集 (x,y) 配对 —— 保证对齐
    const pairs: Record<string, { x: number[]; y: number[] }> = {};
    for (const stock of stockMap.values()) {
      const li = findLocalIdx(stock, dayIdx);
      if (li < 0) continue;
      const eli = findLocalIdx(stock, dayIdx + 5);
      if (eli < 0) continue;
      const r = stock.close[eli] / stock.close[li] - 1;
      if (!Number.isFinite(r)) continue;
      const f = computeFeatures(stock, li, false);
      const closes = Array.from(stock.close.slice(Math.max(0, li - 64), li + 1));
      const highs = Array.from(stock.high.slice(Math.max(0, li - 64), li + 1));
      const pushV = (k: string, v: number | null) => {
        if (v == null || !Number.isFinite(v)) return;
        const pr = (pairs[k] ??= { x: [], y: [] });
        pr.x.push(v); pr.y.push(r);
      };
      pushV('change_pct', stock.change[li]);
      pushV('volatility20d', f.volatility20d);
      pushV('maxDrawdown20d', f.maxDrawdown20d);
      pushV('atr20', f.atr20);
      pushV('volumeRatio', f.volumeRatio);
      pushV('pullbackToMa20Pct', f.pullbackToMa20Pct);
      pushV('breakout20dPct', f.breakout20dPct);
      pushV('rsi14', f.rsi14);
      if (f.maBullish != null) pushV('maBullish', f.maBullish ? 1 : 0);
      pushV('macdBull', f.macdStatus === 'bullish' ? 1 : 0);
      pushV('macdBear', f.macdStatus === 'bearish' ? 1 : 0);
      pushV('logAmount', Math.log10(Math.max(stock.amount[li], 1) * 1000));
      pushV('tscore_buyDailyTrend', buyDailyTrend(closes, p));
      pushV('tscore_sellOverheat', sellDailyOverheat(closes, highs, null, p));
    }
    for (const [k, pr] of Object.entries(pairs)) {
      if (pr.x.length < MARKET_MIN) continue;
      const ic = spearman(pr.x, pr.y);
      if (ic != null) (marketSeries[k] ??= []).push(ic);
    }
    if ((e + 1) % 50 === 0) console.log(`[backtest] 全市场 ${e + 1}/${evalDays.length} 天`);
  }

  // ===================== 7. 分析 =====================

  const report: any = { meta: {}, pool: {}, market: {}, monthly: {} };
  report.meta = {
    evalDays: evalDays.length,
    range: `${evalDays[0]?.day} ~ ${evalDays[evalDays.length - 1]?.day}`,
    split: `IS=${splitIdx}天 / OOS=${evalDays.length - splitIdx}天`,
    presets: presets.map((p) => p.id),
    stocks: stockMap.size,
    caveats: [
      'quality 因子用当前基本面快照(未来函数,权重推导应排除)',
      'ST 过滤用当前名称',
      '行业归属用当前成分',
      '分钟级做T因子不可回测',
    ],
  };

  const FACTOR_KEYS = ['trend', 'entry_timing', 'risk', 'quality', 'liquidity', 'theme_heat', 'chip'];

  /** 逐日 IC 序列（obs 按 day 聚合后对 (因子值, 收益) 做 Spearman） */
  function dailyIcSeries(obs: Obs[], getVal: (o: Obs) => number | null | undefined, nIdx: number): number[] {
    const byDay = new Map<string, { x: number[]; y: number[] }>();
    for (const o of obs) {
      const v = getVal(o);
      const r = o.rets[nIdx];
      if (v == null || Number.isNaN(v) || r == null) continue;
      let d = byDay.get(o.day);
      if (!d) { d = { x: [], y: [] }; byDay.set(o.day, d); }
      d.x.push(v); d.y.push(r);
    }
    const ics: number[] = [];
    for (const d of byDay.values()) {
      const ic = spearman(d.x, d.y);
      if (ic != null) ics.push(ic);
    }
    return ics;
  }

  for (const preset of presets) {
    const { obs, dayStats } = poolResults[preset.id];
    const sec: any = { factorIc: {}, rawIc: {}, quintiles: {}, corr: {}, weights: {}, topNA: {} };

    // 因子 IC（逐日 × 持有期）
    for (const f of FACTOR_KEYS) {
      sec.factorIc[f] = {};
      for (const N of NS) {
        const ics = dailyIcSeries(obs, (o) => o.factors[f], NS.indexOf(N));
        sec.factorIc[f][`T+${N}`] = { ...icStats(ics, splitIdx), days: ics.length };
      }
    }

    // 原始信号 IC（池内, T+5）
    const rawKeys: [string, string][] = [
      ['rps60', 'RPS60'], ['ret60d', '60日涨幅'], ['change', '当日涨幅'], ['vol20', '20日波动率'],
      ['dd20', '20日最大回撤'], ['atr20', 'ATR20%'], ['vr', '量比'], ['pullback', '距MA20回踩%'],
      ['breakout', '突破20日高%'], ['rsi14', 'RSI14'], ['ind', '行业当日涨幅'],
      ['chipConc', '筹码集中度'], ['chipProfit', '获利盘比例'], ['chipPeak', '峰位'], ['chipDrift', '峰漂移'],
    ];
    for (const [k, label] of rawKeys) {
      const ics = dailyIcSeries(obs, (o) => o.raw[k], 1);
      if (ics.length > 0) sec.rawIc[k] = { label, ...icStats(ics, splitIdx) };
    }

    // 五分位（T+5）：逐日按因子分桶后合并
    sec.quintiles = {};
    for (const f of FACTOR_KEYS) {
      const buckets = [0, 1, 2, 3, 4].map(() => ({ n: 0, sum: 0, win: 0 }));
      const byDay = new Map<string, { x: number[]; r: number[] }>();
      for (const o of obs) {
        const v = o.factors[f], r = o.rets[1];
        if (v == null || r == null) continue;
        let d = byDay.get(o.day);
        if (!d) { d = { x: [], r: [] }; byDay.set(o.day, d); }
        d.x.push(v); d.r.push(r);
      }
      for (const d of byDay.values()) {
        if (d.x.length < 5) continue;
        const order = d.x.map((v, i) => i).sort((a, b) => d.x[a] - d.x[b]);
        const q = Math.max(1, Math.floor(order.length / 5));
        order.forEach((i, pos) => {
          const b = Math.min(4, Math.floor(pos / q));
          buckets[b].n++; buckets[b].sum += d.r[i]; if (d.r[i] > 0) buckets[b].win++;
        });
      }
      sec.quintiles[f] = buckets.map((b, i) => ({
        bucket: `Q${i + 1}`, n: b.n,
        meanRet: b.n ? (b.sum / b.n) * 100 : null,
        winRate: b.n ? (b.win / b.n) * 100 : null,
      }));
    }

    // 因子相关矩阵（逐日秩相关均值）
    const corr: number[][] = FACTOR_KEYS.map(() => new Array(FACTOR_KEYS.length).fill(0));
    const corrDays: number[][] = FACTOR_KEYS.map(() => new Array(FACTOR_KEYS.length).fill(0));
    const byDayF = new Map<string, Record<string, number[]>>();
    for (const o of obs) {
      let d = byDayF.get(o.day);
      if (!d) { d = {}; byDayF.set(o.day, d); }
      for (const f of FACTOR_KEYS) {
        const v = o.factors[f];
        if (v != null) (d[f] ??= []).push(v);
      }
    }
    for (const d of byDayF.values()) {
      for (let i = 0; i < FACTOR_KEYS.length; i++) {
        for (let j = i + 1; j < FACTOR_KEYS.length; j++) {
          const ic = spearman(d[FACTOR_KEYS[i]] ?? [], d[FACTOR_KEYS[j]] ?? []);
          if (ic != null) { corr[i][j] += ic; corrDays[i][j]++; }
        }
      }
    }
    sec.corr = FACTOR_KEYS.map((_, i) => FACTOR_KEYS.map((__, j) => (i === j ? 1 : corrDays[i][j] ? corr[i][j] / corrDays[i][j] : 0)));

    // 权重建议（基于 T+5 OOS；quality 排除 —— 未来函数）
    const nonQuality = FACTOR_KEYS.filter((f) => f !== 'quality');
    const icOos = (f: string) => sec.factorIc[f]['T+5'].oos?.mean ?? 0;
    const normalize = (ws: Record<string, number>) => {
      const tot = Object.values(ws).reduce((a, b) => a + b, 0);
      if (tot <= 0) return ws;
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(ws)) out[k] = v / tot;
      return out;
    };
    const cur = normalize(preset.factorWeights as Record<string, number>);
    const propLinear = normalize(Object.fromEntries(nonQuality.map((f) => [f, Math.max(0, icOos(f))])));
    const propSq = normalize(Object.fromEntries(nonQuality.map((f) => [f, Math.max(0, icOos(f)) ** 2])));
    sec.weights = {
      current: cur,
      propLinearOos: { ...propLinear, quality: 0 },
      propSqOos: { ...propSq, quality: 0 },
      icOosT5: Object.fromEntries(FACTOR_KEYS.map((f) => [f, icOos(f)])),
    };

    // 池 vs 市场基线 + top20（当前权重 / 建议权重 线性版）
    const ds = Array.from(dayStats.values()).filter((d) => Number.isFinite(d.poolMean5) && Number.isFinite(d.marketMean5));
    const topCur = ds.filter((d) => Number.isFinite(d.top20Cur5));
    const wl = sec.weights.propLinearOos as Record<string, number>;
    const byDayObs = new Map<string, Obs[]>();
    for (const o of obs) { const arr = byDayObs.get(o.day) ?? []; arr.push(o); byDayObs.set(o.day, arr); }
    const topPropAlphas: number[] = [];
    for (const [day, list] of byDayObs) {
      const market = dayStats.get(day)?.marketMean5;
      if (market == null || !Number.isFinite(market)) continue;
      const scored = list.map((o) => ({ o, s: FACTOR_KEYS.reduce((a, f) => a + (o.factors[f] ?? 0) * (wl[f] ?? 0), 0) }));
      const top = scored.sort((a, b) => b.s - a.s).slice(0, 20).filter((x) => x.o.rets[1] != null);
      if (top.length > 0) topPropAlphas.push(top.reduce((a, x) => a + x.o.rets[1]!, 0) / top.length - market);
    }
    sec.topNA = {
      poolMean5: fmtPct(ds.length ? ds.reduce((a, d) => a + d.poolMean5, 0) / ds.length : null),
      marketMean5: fmtPct(ds.length ? ds.reduce((a, d) => a + d.marketMean5, 0) / ds.length : null),
      alphaMean5: fmtPct(ds.length ? ds.reduce((a, d) => a + (d.poolMean5 - d.marketMean5), 0) / ds.length : null),
      alphaPosPct: ds.length ? (ds.filter((d) => d.poolMean5 - d.marketMean5 > 0).length / ds.length) * 100 : null,
      top20CurAlpha5: fmtPct(topCur.length ? topCur.reduce((a, d) => a + (d.top20Cur5 - d.marketMean5), 0) / topCur.length : null),
      top20CurAlphaPosPct: topCur.length ? (topCur.filter((d) => d.top20Cur5 - d.marketMean5 > 0).length / topCur.length) * 100 : null,
      top20PropAlpha5: fmtPct(topPropAlphas.length ? topPropAlphas.reduce((a, b) => a + b, 0) / topPropAlphas.length : null),
      top20PropAlphaPosPct: topPropAlphas.length ? (topPropAlphas.filter((a) => a > 0).length / topPropAlphas.length) * 100 : null,
      days: ds.length,
    };

    report.pool[preset.id] = sec;
  }

  // 全市场段
  report.market = {};
  for (const [k, ics] of Object.entries(marketSeries)) {
    report.market[k] = { label: marketNames[k] ?? k, ...icStats(ics, splitIdx) };
  }

  // 月度 IC（T+5）
  for (const preset of presets) {
    report.monthly[preset.id] = {};
    const { obs } = poolResults[preset.id];
    for (const f of FACTOR_KEYS) {
      const byDay = new Map<string, { x: number[]; y: number[] }>();
      for (const o of obs) {
        const v = o.factors[f], r = o.rets[1];
        if (v == null || r == null) continue;
        let d = byDay.get(o.day);
        if (!d) { d = { x: [], y: [] }; byDay.set(o.day, d); }
        d.x.push(v); d.y.push(r);
      }
      const dayIcByMonth = new Map<string, number[]>();
      for (const [day, d] of byDay) {
        const ic = spearman(d.x, d.y);
        if (ic != null) {
          const m = day.slice(0, 6);
          const arr = dayIcByMonth.get(m) ?? [];
          arr.push(ic);
          dayIcByMonth.set(m, arr);
        }
      }
      report.monthly[preset.id][f] = Object.fromEntries(
        [...dayIcByMonth.entries()].map(([m, ics]) => [m, ics.reduce((a, b) => a + b, 0) / ics.length])
      );
    }
  }

  writeFileSync('backtest-report.json', JSON.stringify(report, null, 2));
  console.log('\n[backtest] 报告已写入 backtest-report.json');

  // ===================== 8. Markdown 摘要 =====================

  const st = (s: any) => `${fmtNum(s?.mean)} (t=${fmtNum(s?.t, 2)}) | IS ${fmtNum(s?.is?.mean)} / OOS ${fmtNum(s?.oos?.mean)} | ${fmtNum(s?.posPct, 1)}% 正`;

  let md = `# 全市场因子回测报告\n\n`;
  md += `- 评估区间：${report.meta.range}（${report.meta.evalDays} 个交易日）\n`;
  md += `- 时序分割：${report.meta.split}\n`;
  md += `- 股票数：${report.meta.stocks}；持有期：T+1 / T+5 / T+20；IC=逐日秩相关均值\n\n`;
  md += `## 已知偏差\n\n`;
  for (const c of report.meta.caveats) md += `- ${c}\n`;
  md += `\n---\n\n`;

  for (const preset of presets) {
    const sec = report.pool[preset.id];
    md += `## 策略「${preset.id}」\n\n`;
    md += `### 因子 IC（T+1 / T+5 / T+20）\n\n| 因子 | T+1 | T+5 | T+20 |\n|---|---|---|---|\n`;
    for (const f of FACTOR_KEYS) {
      const cells = NS.map((N) => st(sec.factorIc[f][`T+${N}`])).join(' | ');
      md += `| ${f} | ${cells} |\n`;
    }
    md += `\n### 原始信号 IC（池内, T+5）\n\n| 信号 | IC | t | IS | OOS | 正% |\n|---|---|---|---|---|---|\n`;
    for (const [k, v] of Object.entries(sec.rawIc)) {
      const s = v as any;
      md += `| ${s.label} (${k}) | ${fmtNum(s.mean)} | ${fmtNum(s.t, 2)} | ${fmtNum(s.is?.mean)} | ${fmtNum(s.oos?.mean)} | ${fmtNum(s.posPct, 1)}% |\n`;
    }
    md += `\n### 五分位 T+5 收益（Q1=因子分最低 … Q5=最高，括号内为胜率）\n\n| 因子 | Q1 | Q2 | Q3 | Q4 | Q5 | 价差Q5-Q1 |\n|---|---|---|---|---|---|---|\n`;
    for (const f of FACTOR_KEYS) {
      const q = sec.quintiles[f] as any[];
      const cell = (b: any) => b?.meanRet == null ? '-' : `${fmtNum(b.meanRet, 2)}% (${fmtNum(b.winRate, 1)}%)`;
      const spread = q[4]?.meanRet != null && q[0]?.meanRet != null ? q[4].meanRet - q[0].meanRet : null;
      md += `| ${f} | ${q.map((b) => cell(b)).join(' | ')} | ${fmtNum(spread, 2)}% |\n`;
    }
    md += `\n### 因子相关矩阵（逐日均值）\n\n| | ${FACTOR_KEYS.join(' | ')} |\n|---|---${FACTOR_KEYS.map(() => '---').join('|')}|\n`;
    sec.corr.forEach((row: number[], i: number) => {
      md += `| ${FACTOR_KEYS[i]} | ${row.map((v) => fmtNum(v, 2)).join(' | ')} |\n`;
    });
    md += `\n### 权重建议（基于 T+5 OOS IC；quality 未来函数已排除）\n\n| 因子 | 当前 | 线性OOS | 平方OOS | OOS IC |\n|---|---|---|---|---|\n`;
    for (const f of FACTOR_KEYS) {
      md += `| ${f} | ${fmtNum(sec.weights.current[f], 3)} | ${fmtNum(sec.weights.propLinearOos[f], 3)} | ${fmtNum(sec.weights.propSqOos[f], 3)} | ${fmtNum(sec.weights.icOosT5[f])} |\n`;
    }
    md += `\n### 池 vs 市场基线（T+5 日均收益）\n\n`;
    md += `- 池均值：${sec.topNA.poolMean5} / 市场均值：${sec.topNA.marketMean5} / 池超额：${sec.topNA.alphaMean5}（正超额天数 ${sec.topNA.alphaPosPct}%）\n`;
    md += `- 当前权重 Top20 超额：${sec.topNA.top20CurAlpha5}（正天数 ${sec.topNA.top20CurAlphaPosPct}%）\n`;
    md += `- 建议权重(线性OOS) Top20 超额：${sec.topNA.top20PropAlpha5}（正天数 ${sec.topNA.top20PropAlphaPosPct}%）\n\n`;
  }

  md += `## 全市场原始信号 IC（T+5）\n\n| 信号 | IC | t | IS | OOS | 正% |\n|---|---|---|---|---|---|\n`;
  for (const [k, v] of Object.entries(report.market)) {
    const s = v as any;
    md += `| ${s.label} (${k}) | ${fmtNum(s.mean)} | ${fmtNum(s.t, 2)} | ${fmtNum(s.is?.mean)} | ${fmtNum(s.oos?.mean)} | ${fmtNum(s.posPct, 1)}% |\n`;
  }
  md += `\n> 月度 IC 稳定性、rawIc 全量数据见 backtest-report.json\n`;

  writeFileSync('backtest-report.md', md);
  console.log('Markdown 报告已写入 backtest-report.md');
  console.log('\n===== 因子 IC 一览（T+5, OOS）=====');
  for (const preset of presets) {
    console.log(`\n[${preset.id}]`);
    for (const f of FACTOR_KEYS) {
      const s = report.pool[preset.id].factorIc[f]['T+5'];
      console.log(`  ${f.padEnd(14)} IS=${fmtNum(s.is?.mean)} OOS=${fmtNum(s.oos?.mean)} t=${fmtNum(s.t, 2)}`);
    }
  }
}

main()
  .catch((e) => { console.error('[backtest] 失败:', e); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
