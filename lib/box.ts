/**
 * 箱体形态判定 — 译自 a-share-accumulation-breakout signals.py（2026-08-14 调研移植）
 *
 * 把「横盘吸筹平台」与「下跌中继 / 慢牛通道」用可证伪的数学特征区分开：
 *   - 稳健支撑/阻力：92/8 分位（防单根长影线撑破箱体）
 *   - 拒单边通道：收盘线性回归 |归一化斜率| ≤ 0.0025 且 R² < 0.72（R² 高 = 慢牛通道不是横盘）
 *   - 结构完整：支撑/压力各触及 ≥2 次（带宽=箱高18%，同向触及间隔 ≥2 根）
 *   - 震荡而非单边：3 日均线相对中轴 ±1.5% 有效切换 ≥1 次；中部 50% 区间收盘占比 ≥28%
 *   - 前后漂移：前/后半段收盘中位漂移 ≤8%（拒 V 型/单边漂移）
 *   - 时长自适应振幅：横盘越久允许越宽（1 + 0.12·ln(T/20)，封顶 1.25）
 *
 * 当前只产出特征（质量分/位置），不进任何打分权重——先落库攒样本，
 * 等胜率复盘的 IC 验证有效后再考虑升为因子（数据驱动纪律，同 chip 因子路径）。
 */

export interface BoxFeatures {
  /** 是否判定为有效箱体（全部结构条件通过） */
  inBox: boolean;
  /** 箱体质量分 0-100（仅 inBox=true 时有值；数据不足或非箱体为 null） */
  boxQuality: number | null;
  /** 现价在箱体内的位置 (close−底)/箱高：<0 跌破、0~1 箱内、>1 突破箱顶 */
  boxPos: number | null;
  boxTop: number | null;
  boxBottom: number | null;
}

const EMPTY: BoxFeatures = { inBox: false, boxQuality: null, boxPos: null, boxTop: null, boxBottom: null };

/** 简单线性回归：返回归一化日斜率（斜率/均价）与 R² */
function linreg(ys: number[]): { slope: number; r2: number } {
  const n = ys.length;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  const meanX = (n - 1) / 2;
  let sxy = 0, sxx = 0, sst = 0;
  for (let i = 0; i < n; i++) {
    sxy += (i - meanX) * (ys[i] - meanY);
    sxx += (i - meanX) * (i - meanX);
    sst += (ys[i] - meanY) * (ys[i] - meanY);
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const fit = meanY + slope * (i - meanX);
    sse += (ys[i] - fit) * (ys[i] - fit);
  }
  return { slope: meanY === 0 ? 0 : slope / meanY, r2: sst === 0 ? 0 : Math.max(0, 1 - sse / sst) };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 边界触及次数（同向两次触及需间隔 ≥2 根 K 线，防连续贴边重复计数） */
function countTouches(vals: number[], boundary: number, band: number, isTop: boolean): number {
  let count = 0;
  let lastIdx = -99;
  for (let i = 0; i < vals.length; i++) {
    const hit = isTop ? vals[i] >= boundary - band : vals[i] <= boundary + band;
    if (hit && i - lastIdx >= 2) {
      count++;
      lastIdx = i;
    }
  }
  return count;
}

/** 有效摆动次数：3 日均值相对中轴 ±1.5% 的高低切换 */
function countSwings(closes: number[], mid: number): number {
  const sma: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    const s = Math.max(0, i - 2);
    let sum = 0;
    for (let j = s; j <= i; j++) sum += closes[j];
    sma.push(sum / (i - s + 1));
  }
  let state: 'high' | 'low' | null = null;
  let swings = 0;
  for (const v of sma) {
    if (v >= mid * 1.015) {
      if (state === 'low') swings++;
      state = 'high';
    } else if (v <= mid * 0.985) {
      if (state === 'high') swings++;
      state = 'low';
    }
  }
  return swings;
}

/**
 * 判定最近 window 根 K 线是否构成吸筹箱体。
 * closes/highs/lows 按日期升序，长度 ≥30 才判定（不足返回全 null）。
 */
export function boxFeatures(closes: number[], highs: number[], lows: number[], window = 60): BoxFeatures {
  if (closes.length < 30 || highs.length !== closes.length || lows.length !== closes.length) return EMPTY;

  const c = closes.slice(-window);
  const h = highs.slice(-window);
  const l = lows.slice(-window);
  const T = c.length;

  // 稳健支撑/阻力：分位数（去极端影线）
  const sortedH = [...h].sort((a, b) => a - b);
  const sortedL = [...l].sort((a, b) => a - b);
  const top = sortedH[Math.floor(0.92 * (T - 1))];
  const bottom = sortedL[Math.floor(0.08 * (T - 1))];
  const height = top - bottom;
  const mid = (top + bottom) / 2;
  if (height <= 0 || mid <= 0) return EMPTY;

  const latestClose = c[T - 1];
  const boxPos = (latestClose - bottom) / height;

  // 条件 1：振幅（时长自适应，1 + 0.12·ln(T/20) 封顶 1.25）
  const ampMax = 0.20 * Math.min(1.25, 1 + 0.12 * Math.log(T / 20));
  const amp = height / mid;
  if (amp > ampMax) return { ...EMPTY, boxPos, boxTop: top, boxBottom: bottom };

  // 条件 2：拒单边通道（|归一化斜率| ≤ 0.0025 且 R² < 0.72）
  const { slope, r2 } = linreg(c);
  if (Math.abs(slope) > 0.0025 || r2 >= 0.72) return { ...EMPTY, boxPos, boxTop: top, boxBottom: bottom };

  // 条件 3：支撑/压力各触及 ≥2 次（带宽=箱高 18%）
  const band = height * 0.18;
  const touchesTop = countTouches(h, top, band, true);
  const touchesBottom = countTouches(l, bottom, band, false);
  if (touchesTop < 2 || touchesBottom < 2) return { ...EMPTY, boxPos, boxTop: top, boxBottom: bottom };

  // 条件 4：中部 50% 区间收盘占比 ≥28%
  const innerLo = bottom + height * 0.25;
  const innerHi = top - height * 0.25;
  const occupancy = c.filter((v) => v >= innerLo && v <= innerHi).length / T;
  if (occupancy < 0.28) return { ...EMPTY, boxPos, boxTop: top, boxBottom: bottom };

  // 条件 5：有效摆动 ≥1 次
  const swings = countSwings(c, mid);
  if (swings < 1) return { ...EMPTY, boxPos, boxTop: top, boxBottom: bottom };

  // 条件 6：前/后半段收盘中位漂移 ≤8%
  const half = T >> 1;
  const drift = Math.abs(median(c.slice(half)) - median(c.slice(0, half))) / mid;
  if (drift > 0.08) return { ...EMPTY, boxPos, boxTop: top, boxBottom: bottom };

  // 质量分：窄振幅 / 多触及 / 多摆动 / 低漂移 / 低 R² / 高中部占比
  const quality = Math.round(
    25 * (1 - amp / ampMax) +
    20 * Math.min((touchesTop + touchesBottom) / 8, 1) +
    15 * Math.min(swings / 3, 1) +
    15 * (1 - drift / 0.08) +
    15 * (1 - r2 / 0.72) +
    10 * Math.min(occupancy / 0.6, 1)
  );

  return { inBox: true, boxQuality: Math.max(0, Math.min(100, quality)), boxPos, boxTop: top, boxBottom: bottom };
}
