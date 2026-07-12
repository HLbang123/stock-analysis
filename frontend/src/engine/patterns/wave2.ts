import type { Kline, Wave2Pattern } from '../../types';
import { isBearish, bodyPercent } from './candlestick';

/**
 * Detect the "第二波" (Second Wave) pattern:
 *
 * Structure: 上涨 → 回调 → 筑底(企稳) → 反包大阳线
 *
 * Logic:
 * 1. Find a significant uptrend (first wave up)
 * 2. Find a pullback (correction)
 * 3. Find consolidation/base forming
 * 4. Find a strong bullish breakout candle (反包阳线 >5%)
 *
 * This is the CORE pattern from the trading document.
 */
export function detectWave2(klines: Kline[]): Wave2Pattern {
  if (klines.length < 30) {
    return { found: false, phase: 'none' };
  }

  const closes = klines.map(k => k.close);
  const highs = klines.map(k => k.high);
  const lows = klines.map(k => k.low);

  // Step 1: Find a significant uptrend in the lookback window
  // Look for a period where price rose >15% over 10-30 days
  let upStart = -1;
  let upPeak = -1;
  let maxGain = 0;

  // Scan from about 60 days back to find the first wave
  const scanStart = Math.max(0, klines.length - 60);
  for (let i = scanStart; i < klines.length - 10; i++) {
    for (let j = i + 5; j < Math.min(i + 30, klines.length); j++) {
      const gain = (closes[j] - closes[i]) / closes[i];
      if (gain > maxGain && gain > 0.15) {
        maxGain = gain;
        upStart = i;
        upPeak = j;
      }
    }
  }

  if (upStart === -1 || upPeak === -1 || upPeak >= klines.length - 10) {
    return { found: false, phase: 'none' };
  }

  // Step 2: Find the pullback bottom after the peak
  let pullbackEnd = upPeak;
  for (let i = upPeak + 1; i < klines.length - 5; i++) {
    if (lows[i] < lows[pullbackEnd]) {
      pullbackEnd = i;
    }
    // If we start seeing higher lows, we might have found the bottom
    if (i > upPeak + 3 && lows[i] > lows[pullbackEnd] * 1.02 && lows[i + 1] > lows[pullbackEnd] * 1.02) {
      pullbackEnd = i - 1;
      break;
    }
  }

  // Pullback should be at least 3 days after peak
  if (pullbackEnd <= upPeak + 2) {
    return { found: false, phase: 'none' };
  }

  const pullbackDepth = (closes[upPeak] - lows[pullbackEnd]) / closes[upPeak];

  // Step 3: Look for consolidation (base forming) after pullback
  // Then look for a breakout with strong bullish candle

  // Step 4: Find breakout - a strong bullish candle near the end
  let breakoutIndex = -1;
  let breakoutStrength = 0;

  // Search from pullback end to recent
  for (let i = pullbackEnd + 1; i < klines.length; i++) {
    const bodyPct = bodyPercent(klines[i]);
    const isBull = klines[i].close > klines[i].open;
    if (isBull && bodyPct > 3) {
      breakoutIndex = i;
      breakoutStrength = bodyPct;
    }
  }

  // A stronger breakout is preferred (>5%)
  // But we can detect weaker ones too
  if (breakoutIndex === -1) {
    return {
      found: false,
      phase: 'base',  // It's consolidating but hasn't broken out
      upStart, upPeak, pullbackEnd,
      description: '筑底中，等待反包阳线',
    };
  }

  // Determine phase based on whether breakout is strong enough
  if (breakoutStrength >= 5) {
    return {
      found: true,
      phase: 'breakout',
      upStart, upPeak, pullbackEnd, breakoutIndex, breakoutStrength,
      description: `第二波反包阳线！涨幅${breakoutStrength.toFixed(1)}%，回调幅度${(pullbackDepth * 100).toFixed(1)}%`,
    };
  }

  // Weaker breakout - it's a signal but not strong confirmation
  if (breakoutStrength >= 3) {
    return {
      found: true,
      phase: 'breakout',
      upStart, upPeak, pullbackEnd, breakoutIndex, breakoutStrength,
      description: `疑似第二波启动（阳线力度${breakoutStrength.toFixed(1)}%，理想>5%）`,
    };
  }

  return {
    found: false,
    phase: 'base',
    upStart, upPeak, pullbackEnd,
    description: '等待更有力的反包阳线',
  };
}

/**
 * Detect W-pattern (ABC wave) completion.
 *
 * Structure: Down A → Up B → Down C → Breakout
 * Classic "W" bottom formation.
 */
export function detectWPattern(klines: Kline[]): { found: boolean; description?: string } {
  if (klines.length < 30) return { found: false };

  const lows = klines.map(k => k.low);
  const closes = klines.map(k => k.close);
  const highs = klines.map(k => k.high);

  // Find two distinct troughs
  const window = klines.slice(-40);
  const windowLows = window.map(k => k.low);

  // Find lowest points
  let aLow = -1, cLow = -1;
  let minVal = Infinity;
  let secondMinVal = Infinity;

  for (let i = 0; i < windowLows.length - 5; i++) {
    const val = windowLows[i];
    // Check if this is a local minimum
    const isLocalMin =
      (i === 0 || val <= windowLows[i - 1]) &&
      (i === windowLows.length - 1 || val <= windowLows[i + 1]);

    if (isLocalMin) {
      if (val < minVal) {
        secondMinVal = minVal;
        cLow = aLow;
        minVal = val;
        aLow = i;
      } else if (val < secondMinVal) {
        secondMinVal = val;
        cLow = i;
      }
    }
  }

  // Need two distinct bottoms
  if (aLow === -1 || cLow === -1 || Math.abs(aLow - cLow) < 5) {
    return { found: false };
  }

  // Make sure A comes first, C comes second
  if (aLow > cLow) {
    [aLow, cLow] = [cLow, aLow];
  }

  // Find the B peak between A and C
  let bPeak = aLow;
  for (let i = aLow + 1; i < cLow; i++) {
    if (highs[i] > highs[bPeak]) {
      bPeak = i;
    }
  }

  // B peak should be between A and C lows
  if (bPeak <= aLow || bPeak >= cLow) {
    return { found: false };
  }

  // Check for breakout after C
  const recentIdx = klines.length - 1;
  const recentCloses = closes.slice(cLow, recentIdx + 1);

  let breakout = false;
  for (let i = 1; i < recentCloses.length; i++) {
    if (recentCloses[i] > highs[bPeak]) {
      breakout = true;
      break;
    }
  }

  // Even without breakout, if recent price is rising + candle is bullish
  const lastCandle = klines[klines.length - 1];
  const lastIsBullish = lastCandle.close > lastCandle.open;

  if (breakout) {
    return { found: true, description: 'W型（ABC浪）完成，突破B浪高点' };
  }

  if (lastIsBullish && bodyPercent(lastCandle) > 3) {
    return { found: true, description: 'W型企稳，C浪后出现反包阳线' };
  }

  return { found: false, description: 'W型未完成，等待突破' };
}
