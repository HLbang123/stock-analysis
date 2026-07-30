/**
 * 波段评分 — 分时（1 分钟）派生量
 *
 * /api/minute 返回当日分时 {time,price,volume,avgPrice}[]，但 avgPrice 是 price 的副本（bug），
 * 这里自算累计 VWAP，绝不读 avgPrice。/api/minute 在腾讯分时拿不到时会回退 5 分 K，
 * 用时间间隔中位数检测 granularity 并据此收缩动量/量能窗口。
 *
 * 纯函数，无 I/O。所有量供 scorer.ts 因子打分用。
 */

export interface MinutePoint {
  time: string; // "HHMM"
  price: number;
  volume: number;
}

/** 聚合出的 N 分 K（注：1 分数据每分钟只有收盘价，high/low 为组内收盘价极值，近似） */
export interface MinuteBar {
  time: string; // 起始 "HHMM"
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface IntradayContext {
  count: number;
  granularity: 'm1' | 'm5';
  sufficient: boolean; // count >= 10
  open: number;
  high: number;
  low: number;
  last: number;
  vwap: number; // 最新累计 VWAP
  rangePosPct: number; // (last-low)/(high-low)*100，日内位置 0-100
  vwapDevPct: number; // (last-vwap)/vwap*100，偏离 VWAP 的百分比
  mom15: number; // 近 15 分钟价格回归斜率，bps/分钟；负=盘中回调
  downVolRatio: number; // 近 30 分钟下跌分钟量占比 0-1
  last5VolRatio: number; // 近 5 分钟均量 / 全日均量
  windowLen: number; // 动量/量能实际使用的窗口长度（受 granularity 收缩）
  // 做 T 规则派生量（数据不足时为中性：surge=0 / supportDist=null）
  m5VolSurgeRatio: number; // 最新5分K量 / 前5分K均量；0=数据不足
  m5LastUp: boolean; // 最新5分K收>前一根收（放量上涨判定）
  m15SupportDistPct: number | null; // 最新15分K收盘高于前期15分低点的%；null=不足；负=跌破支撑
}

function toMinutes(time: string): number {
  const t = time.replace(':', '');
  const hh = parseInt(t.slice(0, 2), 10);
  const mm = parseInt(t.slice(2, 4), 10);
  if (Number.isNaN(hh) || Number.isNaN(mm)) return NaN;
  return hh * 60 + mm;
}

function medianGap(mins: number[]): number {
  if (mins.length < 2) return 1;
  const gaps: number[] = [];
  for (let i = 1; i < mins.length; i++) {
    const g = mins[i] - mins[i - 1];
    if (g > 0) gaps.push(g);
  }
  if (gaps.length === 0) return 1;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

/** 近 N 分钟价格的最小二乘回归斜率，归一化为 bps/分钟 */
function regressionSlopeBps(prices: number[], n: number): number {

  const slice = prices.slice(Math.max(0, prices.length - n));
  if (slice.length < 3) return 0;
  const m = slice.length;
  const xMean = (m - 1) / 2;
  const yMean = slice.reduce((a, b) => a + b, 0) / m;
  let num = 0;
  let den = 0;
  for (let i = 0; i < m; i++) {
    num += (i - xMean) * (slice[i] - yMean);
    den += (i - xMean) ** 2;
  }
  if (den === 0) return 0;
  const slope = num / den; // 价格/分钟
  const last = slice[m - 1];
  if (!last) return 0;
  return (slope / last) * 10000; // bps/分钟
}

function formatHHMM(mins: number): string {
  const hh = Math.floor(mins / 60);
  const mm = mins % 60;
  return `${String(hh).padStart(2, '0')}${String(mm).padStart(2, '0')}`;
}

/**
 * 1 分分时聚合成 N 分 K。按时钟分钟 floor 分组，兼容 m1 与 m5 回退输入：
 * m1 输入时每 N 个点合一根；m5 回退输入时（点间隔已是 5 分）5 分 K 每点一根、15 分 K 每 3 点一根。
 * 午休时段跨度大，不会跨上下午混并。high/low 取组内收盘价极值（1 分数据无分内高低，近似）。
 */
function aggregateMinuteBars(pts: MinutePoint[], barMinutes: number): MinuteBar[] {
  if (pts.length === 0) return [];
  const groups = new Map<number, MinutePoint[]>();
  for (const p of pts) {
    const m = toMinutes(p.time);
    if (!Number.isFinite(m)) continue;
    const bucket = Math.floor(m / barMinutes) * barMinutes;
    const arr = groups.get(bucket);
    if (arr) arr.push(p);
    else groups.set(bucket, [p]);
  }
  return Array.from(groups.keys())
    .sort((a, b) => a - b)
    .map((b) => {
      const arr = groups.get(b)!;
      const prices = arr.map((p) => p.price);
      return {
        time: formatHHMM(b),
        open: prices[0],
        high: Math.max(...prices),
        low: Math.min(...prices),
        close: prices[prices.length - 1],
        volume: arr.reduce((s, p) => s + (p.volume || 0), 0),
      };
    });
}

/**
 * 由分时序列构建日内上下文。输入应为当日分时（升序）。
 * 不足 10 个点 → sufficient=false，调用方应走 degraded 分支。
 */
export function buildIntradayContext(minute: MinutePoint[]): IntradayContext {
  const pts = minute.filter((p) => Number.isFinite(p.price) && p.price > 0 && Number.isFinite(p.volume));
  const count = pts.length;

  const empty: IntradayContext = {
    count,
    granularity: 'm1',
    sufficient: false,
    open: 0, high: 0, low: 0, last: 0, vwap: 0,
    rangePosPct: 50, vwapDevPct: 0, mom15: 0, downVolRatio: 0.5, last5VolRatio: 1,
    windowLen: 0,
    m5VolSurgeRatio: 0, m5LastUp: false, m15SupportDistPct: null,
  };
  if (count < 10) return empty;

  // granularity 检测：时间间隔中位数 >=5 视为 5 分 K 回退
  const mins = pts.map((p) => toMinutes(p.time)).filter((m) => Number.isFinite(m));
  const gap = mins.length >= 2 ? medianGap(mins) : 1;
  const granularity: 'm1' | 'm5' = gap >= 5 ? 'm5' : 'm1';

  const prices = pts.map((p) => p.price);
  const vols = pts.map((p) => p.volume);
  const open = prices[0];
  const high = Math.max(...prices);
  const low = Math.min(...prices);
  const last = prices[prices.length - 1];

  // 累计 VWAP = Σ(price*vol)/Σ(vol)
  let pv = 0;
  let vv = 0;
  for (let i = 0; i < count; i++) {
    pv += prices[i] * vols[i];
    vv += vols[i];
  }
  const vwap = vv > 0 ? pv / vv : last;

  const span = Math.max(high - low, 1e-6);
  const rangePosPct = ((last - low) / span) * 100;
  const vwapDevPct = vwap > 0 ? ((last - vwap) / vwap) * 100 : 0;

  // 动量窗口：m1 用 15，m5 收缩到 6（≈30 分钟）
  const momWin = granularity === 'm1' ? Math.min(15, count) : Math.min(6, count);
  const mom15 = regressionSlopeBps(prices, momWin);

  // 量能窗口：m1 用 30，m5 收缩到 6
  const volWin = granularity === 'm1' ? Math.min(30, count) : Math.min(6, count);
  let downVol = 0;
  let winVol = 0;
  for (let i = prices.length - volWin; i < prices.length; i++) {
    if (i <= 0) continue;
    winVol += vols[i];
    if (prices[i] < prices[i - 1]) downVol += vols[i];
  }
  const downVolRatio = winVol > 0 ? downVol / winVol : 0.5;

  // 近 5 分钟均量 / 全日均量（m5 时收缩到 3）
  const tailN = granularity === 'm1' ? Math.min(5, count) : Math.min(3, count);
  const tailSlice = vols.slice(-tailN);
  const tailMean = tailSlice.reduce((a, b) => a + b, 0) / tailN;
  const allMean = vv / count;
  const last5VolRatio = allMean > 0 ? tailMean / allMean : 1;

  // 做 T 规则派生量：5 分 K 放量 + 15 分 K 支撑位
  const m5Bars = aggregateMinuteBars(pts, 5);
  const m15Bars = aggregateMinuteBars(pts, 15);

  let m5VolSurgeRatio = 0;
  let m5LastUp = false;
  if (m5Bars.length >= 4) {
    const last = m5Bars[m5Bars.length - 1];
    const prev = m5Bars[m5Bars.length - 2];
    const others = m5Bars.slice(0, -1);
    const avgVol = others.reduce((s, b) => s + b.volume, 0) / others.length;
    m5VolSurgeRatio = avgVol > 0 ? last.volume / avgVol : 0;
    m5LastUp = last.close > prev.close;
  }

  let m15SupportDistPct: number | null = null;
  if (m15Bars.length >= 4) {
    const lastClose = m15Bars[m15Bars.length - 1].close;
    let priorLow = Infinity;
    for (let i = 0; i < m15Bars.length - 1; i++) priorLow = Math.min(priorLow, m15Bars[i].low);
    if (Number.isFinite(priorLow) && priorLow > 0) {
      m15SupportDistPct = ((lastClose - priorLow) / priorLow) * 100;
    }
  }

  return {
    count,
    granularity,
    sufficient: true,
    open,
    high,
    low,
    last,
    vwap,
    rangePosPct: Math.max(0, Math.min(100, rangePosPct)),
    vwapDevPct,
    mom15,
    downVolRatio: Math.max(0, Math.min(1, downVolRatio)),
    last5VolRatio,
    windowLen: volWin,
    m5VolSurgeRatio,
    m5LastUp,
    m15SupportDistPct,
  };
}
