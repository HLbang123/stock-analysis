import { ema, lastValue } from './ma';

export interface MACDResult {
  dif: (number | null)[];
  dea: (number | null)[];
  histogram: (number | null)[];
}

/**
 * MACD with standard parameters: fast=12, slow=26, signal=9.
 * DIF = EMA12 - EMA26
 * DEA = EMA9 of DIF
 * Histogram = 2 * (DIF - DEA)
 */
export function calcMACD(
  closes: number[],
  fast = 12,
  slow = 26,
  signal = 9
): MACDResult {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);

  const dif: (number | null)[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (emaFast[i] !== null && emaSlow[i] !== null) {
      dif.push(emaFast[i]! - emaSlow[i]!);
    } else {
      dif.push(null);
    }
  }

  // DEA = EMA of DIF values
  const difVals = dif.filter((v): v is number => v !== null);
  const deaRaw = ema(difVals, signal);

  const dea: (number | null)[] = [];
  let nullCount = 0;
  for (const d of dif) {
    if (d === null) nullCount++;
  }
  for (let i = 0; i < nullCount + signal - 1 && i < closes.length; i++) {
    dea.push(null);
  }
  for (const v of deaRaw) {
    if (v !== null) dea.push(v);
  }
  while (dea.length < closes.length) {
    dea.push(null);
  }

  const histogram: (number | null)[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (dif[i] !== null && dea[i] !== null) {
      histogram.push(2 * (dif[i]! - dea[i]!));
    } else {
      histogram.push(null);
    }
  }

  return { dif, dea, histogram };
}

/**
 * Check for golden cross (DIF crosses above DEA) or death cross (DIF crosses below DEA).
 */
export function findMACDCross(dif: (number | null)[], dea: (number | null)[]): {
  goldenCrosses: number[];
  deathCrosses: number[];
} {
  const goldenCrosses: number[] = [];
  const deathCrosses: number[] = [];

  for (let i = 1; i < dif.length; i++) {
    if (dif[i] === null || dea[i] === null || dif[i - 1] === null || dea[i - 1] === null) continue;
    // Golden cross: DIF was below DEA, now above
    if (dif[i - 1]! <= dea[i - 1]! && dif[i]! > dea[i]!) {
      goldenCrosses.push(i);
    }
    // Death cross: DIF was above DEA, now below
    if (dif[i - 1]! >= dea[i - 1]! && dif[i]! < dea[i]!) {
      deathCrosses.push(i);
    }
  }

  return { goldenCrosses, deathCrosses };
}

/**
 * Check for divergence.
 * Bullish divergence: price makes lower low but DIF makes higher low.
 * Bearish divergence: price makes higher high but DIF makes lower high.
 */
export function findMACDDivergence(
  prices: number[],
  dif: (number | null)[],
  window: number = 20
): { bullish: number[]; bearish: number[] } {
  const bullish: number[] = [];
  const bearish: number[] = [];

  if (prices.length < window) return { bullish, bearish };

  // Look at recent window for divergence
  for (let i = prices.length - 1; i >= window; i--) {
    if (dif[i] === null) continue;

    // Check last window for local min/max
    const priceSlice = prices.slice(i - window, i + 1);
    const difSlice = dif.slice(i - window, i + 1) as number[];

    const priceMinIdx = priceSlice.indexOf(Math.min(...priceSlice));
    const priceMaxIdx = priceSlice.indexOf(Math.max(...priceSlice));

    // Bullish: price at minimum but DIF not at minimum
    if (priceMinIdx === priceSlice.length - 1) {
      const difMinIdx = difSlice.indexOf(Math.min(...difSlice.filter(v => v !== null) as number[]));
      if (difMinIdx > 0 && difMinIdx < priceSlice.length - 3) {
        bullish.push(i);
      }
    }

    // Bearish: price at maximum but DIF not at maximum
    if (priceMaxIdx === priceSlice.length - 1) {
      const difMaxIdx = difSlice.indexOf(Math.max(...difSlice.filter(v => v !== null) as number[]));
      if (difMaxIdx > 0 && difMaxIdx < priceSlice.length - 3) {
        bearish.push(i);
      }
    }
  }

  return { bullish, bearish };
}
