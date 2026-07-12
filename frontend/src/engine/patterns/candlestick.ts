import type { Kline, CandlePattern, CandleType } from '../../types';

/**
 * Detect candle type for a single K-line.
 */
export function detectCandleType(k: Kline): CandleType {
  const body = Math.abs(k.close - k.open);
  const upperShadow = k.high - Math.max(k.open, k.close);
  const lowerShadow = Math.min(k.open, k.close) - k.low;
  const range = k.high - k.low;

  if (range === 0) return 'normal';

  const bodyRatio = body / range;
  const upperRatio = upperShadow / range;
  const lowerRatio = lowerShadow / range;

  // Doji: body is tiny (< 10% of range)
  if (bodyRatio < 0.1) return 'doji';

  // Hammer / Inverted Hammer: body + shadow pattern
  if (lowerRatio > 0.5 && upperRatio < 0.2 && bodyRatio < 0.4) return 'hammer';
  if (upperRatio > 0.5 && lowerRatio < 0.2 && bodyRatio < 0.4) return 'shootingStar';

  // Long shadows
  if (lowerRatio > 0.65) return 'longLowerShadow';
  if (upperRatio > 0.65) return 'longUpperShadow';

  // Marubozu: almost no shadows
  if (upperRatio < 0.05 && lowerRatio < 0.05) return 'marubozu';

  return 'normal';
}

/**
 * Check if candle is bullish (close > open).
 */
export function isBullish(k: Kline): boolean {
  return k.close > k.open;
}

/**
 * Check if candle is bearish (close < open).
 */
export function isBearish(k: Kline): boolean {
  return k.close < k.open;
}

/**
 * Get body size as percentage of close price.
 */
export function bodyPercent(k: Kline): number {
  if (k.close === 0) return 0;
  return Math.abs(k.close - k.open) / k.close * 100;
}

/**
 * Get upper shadow ratio (shadow / range).
 */
export function upperShadowRatio(k: Kline): number {
  const range = k.high - k.low;
  if (range === 0) return 0;
  return (k.high - Math.max(k.open, k.close)) / range;
}

/**
 * Get lower shadow ratio (shadow / range).
 */
export function lowerShadowRatio(k: Kline): number {
  const range = k.high - k.low;
  if (range === 0) return 0;
  return (Math.min(k.open, k.close) - k.low) / range;
}

/**
 * Detect all notable candle patterns in the recent K-lines.
 * Only checks the most recent 20 candles.
 */
export function detectPatterns(klines: Kline[]): CandlePattern[] {
  const patterns: CandlePattern[] = [];
  const start = Math.max(0, klines.length - 20);

  for (let i = start; i < klines.length; i++) {
    const type = detectCandleType(klines[i]);
    if (type !== 'normal') {
      const desc: Record<CandleType, string> = {
        doji: '十字星',
        hammer: '锤子线',
        shootingStar: '射击之星',
        longLowerShadow: '长下影线',
        longUpperShadow: '长上影线',
        marubozu: '光头光脚',
        normal: '',
      };
      patterns.push({
        type,
        index: i,
        date: klines[i].date,
        description: desc[type],
      });
    }
  }

  return patterns;
}

/**
 * Check if a candle is a strong bullish candle (body > 5%).
 */
export function isStrongBullish(k: Kline): boolean {
  return isBullish(k) && bodyPercent(k) > 5;
}

/**
 * Check if price is in a downtrend (looking at recent candles).
 */
export function isInDowntrend(klines: Kline[], lookback: number = 5): boolean {
  if (klines.length < lookback) return false;
  const recent = klines.slice(-lookback);
  const firstClose = recent[0].close;
  const lastClose = recent[recent.length - 1].close;
  return lastClose < firstClose;
}

/**
 * Check if price is in an uptrend.
 */
export function isInUptrend(klines: Kline[], lookback: number = 5): boolean {
  if (klines.length < lookback) return false;
  const recent = klines.slice(-lookback);
  const firstClose = recent[0].close;
  const lastClose = recent[recent.length - 1].close;
  return lastClose > firstClose;
}

/**
 * Check if price is near a local high.
 */
export function isNearHigh(klines: Kline[], window: number = 20): boolean {
  if (klines.length < window) return false;
  const recent = klines.slice(-window);
  const maxClose = Math.max(...recent.map(k => k.close));
  const lastClose = recent[recent.length - 1].close;
  return lastClose >= maxClose * 0.97; // within 3% of recent high
}
