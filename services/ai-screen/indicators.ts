/**
 * AI 筛选 — 技术特征计算
 *
 * 补 lib/indicators.ts 缺的 ATR / 最大回撤 / 波动率 / 量比，
 * 以及 MACD/RSI 状态判定（状态化而非序列，供因子打分用）。
 * 输入序列均按日期升序（最旧在前，最新在末）。
 */

import { computeChipDistribution, type ChipBar } from '@/lib/chip';

export interface ChipFeatures {
  chipConcentration: number | null;
  chipProfitRatio: number | null;
  chipPeakPos: number | null;
  chipPeakDrift: number | null;
}

/** 筹码峰 4 子维度（薄封装 lib/chip.ts 单一事实源）。turnoverRates 与 closes 等长，可含 null。 */
export function chipFeatures(
  closes: number[], highs: number[], lows: number[], vols: number[],
  turnoverRates: (number | null)[], currentPrice: number,
): ChipFeatures {
  const n = Math.min(closes.length, highs.length, lows.length, vols.length);
  const bars: ChipBar[] = [];
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(closes[i]) || !Number.isFinite(highs[i]) || !Number.isFinite(lows[i])) continue;
    bars.push({ high: highs[i], low: lows[i], close: closes[i], vol: vols[i] ?? 0, turnoverRate: turnoverRates[i] ?? null });
  }
  if (bars.length < 10 || !currentPrice || currentPrice <= 0) {
    return { chipConcentration: null, chipProfitRatio: null, chipPeakPos: null, chipPeakDrift: null };
  }

  // 主窗口：最近 60 根
  const mainBars = bars.slice(Math.max(0, bars.length - 60));
  const main = computeChipDistribution(mainBars, currentPrice);
  if (!main) return { chipConcentration: null, chipProfitRatio: null, chipPeakPos: null, chipPeakDrift: null };

  // peakDrift：与 5 日前窗口的主峰对比（需多 5 根历史）
  let drift: number | null = null;
  if (bars.length > 60) {
    const prevBars = bars.slice(bars.length - 65, bars.length - 5);
    const prevPrice = prevBars[prevBars.length - 1]?.close ?? currentPrice;
    const prev = computeChipDistribution(prevBars, prevPrice);
    if (prev) drift = (main.dominantPeak - prev.dominantPeak) / main.avgCost;
  }

  return {
    chipConcentration: main.concentration90,
    chipProfitRatio: main.profitRatio,
    chipPeakPos: main.peakPos,
    chipPeakDrift: drift != null ? Math.round(drift * 1000) / 1000 : null,
  };
}

/** 简单移动平均序列 */
export function ma(values: number[], period: number): number[] {
  const out = new Array(values.length).fill(null) as number[];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** 指数移动平均序列（等价 pandas ewm(span=N, adjust=false)） */
export function ema(values: number[], span: number): number[] {
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

/** 最后一根的 MACD 状态：DIF 上穿/下穿 DEA */
export function macdStatus(closes: number[]): string {
  if (closes.length < 35) return 'neutral';
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const dif = closes.map((_, i) => (ema12[i] != null && ema26[i] != null ? ema12[i]! - ema26[i]! : null));
  const dea = ema(dif.map((v) => v ?? 0), 9);
  const n = closes.length;
  const dNow = dif[n - 1];
  const dPrev = dif[n - 2];
  const eNow = dea[n - 1];
  const ePrev = dea[n - 2];
  if (dNow == null || dPrev == null || eNow == null || ePrev == null) return 'neutral';
  if (dPrev <= ePrev && dNow > eNow) return 'bullish';
  if (dPrev >= ePrev && dNow < eNow) return 'bearish';
  return dNow > eNow ? 'bullish' : dNow < eNow ? 'bearish' : 'neutral';
}

/** Wilder RSI 最后一根值 */
export function rsi(closes: number[], period: number): number | null {
  if (closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gain += ch;
    else loss -= ch;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = ch > 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** RSI 状态：<30 超卖，>70 超买 */
export function rsiStatus(closes: number[]): string {
  const v = rsi(closes, 14);
  if (v == null) return 'neutral';
  if (v < 30) return 'oversold';
  if (v > 70) return 'overbought';
  return 'neutral';
}

/** 20 日波动率（日收益标准差 ×√20 ×100，近似年化百分比） */
export function volatility20d(closes: number[]): number | null {
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

/** 20 日最大回撤百分比（负值，如 -8.5 表示回撤 8.5%） */
export function maxDrawdown20d(closes: number[]): number | null {
  if (closes.length < 2) return null;
  const start = Math.max(0, closes.length - 20);
  const slice = closes.slice(start);
  let peak = slice[0];
  let maxDd = 0;
  for (const c of slice) {
    if (c > peak) peak = c;
    const dd = (c - peak) / peak;
    if (dd < maxDd) maxDd = dd;
  }
  return maxDd * 100;
}

/** 20 日 ATR 占价格百分比（True Range 均值 / close ×100） */
export function atr20pct(closes: number[], highs: number[], lows: number[]): number | null {
  const n = closes.length;
  if (n < 21) return null;
  const trs: number[] = [];
  for (let i = n - 20; i < n; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    );
    trs.push(tr);
  }
  const atr = trs.reduce((a, b) => a + b, 0) / trs.length;
  const lastClose = closes[n - 1];
  if (!lastClose) return null;
  return (atr / lastClose) * 100;
}

/** 量比 = 最新成交量 / 20 日均量 */
export function volumeRatio(vols: number[]): number | null {
  if (vols.length < 21) return null;
  const last = vols[vols.length - 1];
  const slice = vols.slice(vols.length - 21, vols.length - 1); // 前 20 根
  const avg = slice.reduce((a, b) => a + b, 0) / slice.length;
  if (!avg) return null;
  return last / avg;
}

/** 最后一根 MA 多头排列(MA5>MA13>MA55);序列不足返回 null */
export function maBullish(closes: number[]): boolean | null {
  if (closes.length < 55) return null;
  const ma5 = ma(closes, 5);
  const ma13 = ma(closes, 13);
  const ma55 = ma(closes, 55);
  const n = closes.length - 1;
  if (ma5[n] == null || ma13[n] == null || ma55[n] == null) return null;
  if (ma5[n]! > ma13[n]! && ma13[n]! > ma55[n]!) return true;
  if (ma5[n]! < ma13[n]! && ma13[n]! < ma55[n]!) return false;
  return false;
}

/** 距 MA20 的回踩幅度 (latestClose−MA20)/MA20×100;序列不足返回 null */
export function pullbackToMa20Pct(closes: number[]): number | null {
  if (closes.length < 20) return null;
  const ma20 = ma(closes, 20);
  const n = closes.length - 1;
  const m = ma20[n];
  const last = closes[n];
  if (m == null || !m || !last) return null;
  return ((last - m) / m) * 100;
}

/** 突破 20 日最高的幅度 (latestClose−20日最高)/20日最高×100;近高(>=-1.5)视为突破 setup;序列不足返回 null */
export function breakout20dPct(closes: number[], highs: number[]): number | null {
  const n = closes.length;
  if (n < 2 || highs.length !== n) return null;
  const start = Math.max(0, n - 20);
  let hi = -Infinity;
  for (let i = start; i < n - 1; i++) hi = Math.max(hi, highs[i]); // 不含当日,看是否突破前高
  if (!Number.isFinite(hi) || hi <= 0) return null;
  const last = closes[n - 1];
  return ((last - hi) / hi) * 100;
}

/**
 * 综合技术信号分（0-100）：MA 多头 + MACD 多头 + RSI 健康 + 站上 MA20 + 量价配合
 * 简化版 alphasift signal_score,仅供 risk.ts 风险层读取(weak_signal),不再作为因子输入。
 */
export function signalScore(closes: number[], vols: number[]): number | null {
  if (closes.length < 55) return null;
  const ma5 = ma(closes, 5);
  const ma13 = ma(closes, 13);
  const ma20 = ma(closes, 20);
  const ma55 = ma(closes, 55);
  const n = closes.length;
  const last = closes[n - 1];
  let score = 50;

  // MA 多头排列
  if (ma5[n - 1]! > ma13[n - 1]! && ma13[n - 1]! > ma55[n - 1]!) score += 15;
  else if (ma5[n - 1]! < ma13[n - 1]! && ma13[n - 1]! < ma55[n - 1]!) score -= 15;

  // 站上 MA20
  if (last > ma20[n - 1]!) score += 8;
  else score -= 8;

  // MACD 状态
  const ms = macdStatus(closes);
  if (ms === 'bullish') score += 10;
  else if (ms === 'bearish') score -= 10;

  // RSI 健康（40-60 中性偏强加分）
  const r = rsi(closes, 14);
  if (r != null) {
    if (r >= 45 && r <= 65) score += 7;
    else if (r > 70) score -= 5;
    else if (r < 30) score += 3; // 超卖反弹预期
  }

  // 量价配合：放量上涨
  const vr = volumeRatio(vols);
  if (vr != null && last > closes[n - 2] && vr > 1.2) score += 5;

  return Math.max(0, Math.min(100, score));
}
