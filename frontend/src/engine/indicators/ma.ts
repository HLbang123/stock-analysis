/**
 * Simple Moving Average (SMA).
 * Returns array aligned with input data (null-padded at front).
 */
export function sma(values: number[], period: number): (number | null)[] {
  const result: (number | null)[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      result.push(null);
    } else {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) {
        sum += values[j];
      }
      result.push(sum / period);
    }
  }
  return result;
}

/**
 * Exponential Moving Average (EMA).
 */
export function ema(values: number[], period: number): (number | null)[] {
  const result: (number | null)[] = [];
  const multiplier = 2 / (period + 1);

  // Use SMA for first value
  let firstEma: number | null = null;
  for (let i = period - 1; i < values.length && firstEma === null; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    firstEma = sum / period;
  }

  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      result.push(null);
    } else if (i === period - 1 && firstEma !== null) {
      result.push(firstEma);
    } else {
      const prev = result[i - 1]!;
      result.push((values[i] - prev) * multiplier + prev);
    }
  }

  return result;
}

/**
 * Get the last non-null value from an array.
 */
export function lastValue(arr: (number | null)[]): number | null {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] !== null) return arr[i];
  }
  return null;
}

/**
 * Calculate all MA values for a set of K-lines.
 */
export function calcMAs(
  closes: number[],
  periods: number[] = [5, 10, 20]
): Map<number, (number | null)[]> {
  const result = new Map<number, (number | null)[]>();
  for (const p of periods) {
    result.set(p, sma(closes, p));
  }
  return result;
}
