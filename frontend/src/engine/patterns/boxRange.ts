import type { Kline, BoxRange } from '../../types';

/**
 * Detect box/consolidation range (箱体震荡区间).
 *
 * Looks for a period where price oscillated within a narrow range.
 * The document mentions "3 months of box consolidation" as a key pattern.
 *
 * Returns the most recent box range found.
 */
export function detectBoxRange(klines: Kline[], minDays: number = 15): BoxRange | null {
  if (klines.length < minDays) return null;

  // Look at different windows from recent data
  const windows = [60, 40, 30, 20]; // try different window sizes
  let bestBox: BoxRange | null = null;

  for (const window of windows) {
    if (klines.length < window) continue;
    const slice = klines.slice(-window);
    const highs = slice.map(k => k.high);
    const lows = slice.map(k => k.low);

    const top = Math.max(...highs);
    const bottom = Math.min(...lows);
    const range = (top - bottom) / bottom;

    // Box should be within ~15% range
    if (range < 0.15) {
      // Check if most candles are within this range
      let withinBox = 0;
      for (const k of slice) {
        if (k.high <= top * 1.02 && k.low >= bottom * 0.98) {
          withinBox++;
        }
      }
      const ratio = withinBox / slice.length;

      if (ratio > 0.8) {
        const box: BoxRange = {
          top,
          bottom,
          startIndex: klines.length - window,
          endIndex: klines.length - 1,
          days: window,
        };

        // Prefer longer boxes
        if (!bestBox || box.days > bestBox.days) {
          bestBox = box;
        }
      }
    }
  }

  return bestBox;
}

/**
 * Check if the latest price has broken above the box top.
 */
export function checkBoxBreakout(klines: Kline[], box: BoxRange): boolean {
  if (klines.length < 3) return false;
  const recent = klines.slice(-3);
  const lastClose = recent[recent.length - 1].close;
  const avgVol = recent.reduce((sum, k) => sum + k.volume, 0) / recent.length;
  const prevAvgVol = klines.slice(-13, -3).reduce((sum, k) => sum + k.volume, 0) / 10;

  // Price breaks above box top with increased volume
  return lastClose > box.top && avgVol > prevAvgVol * 1.2 && recent.some(k => k.close > box.top);
}
