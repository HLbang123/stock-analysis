import type { Kline } from '../../types';

/**
 * Detect "对子顶" (Pair Top) pattern.
 *
 * From the document:
 * "如果K线形态出现明显的'对子顶'（两根K线最高点或收盘价数字相同）、
 *  上影线太长、放巨量，这三个信号凑在一起，往往是阶段性见顶的信号"
 *
 * 对子顶: Two candles with identical high prices or identical closing prices.
 */
export function detectDuiziDing(klines: Kline[]): {
  found: boolean;
  index1?: number;
  index2?: number;
  type?: 'high' | 'close';
  value?: number;
  description?: string;
} {
  if (klines.length < 3) return { found: false };

  // Check the most recent candles against earlier ones
  const recent = klines.slice(-10);

  for (let i = recent.length - 1; i >= 1; i--) {
    for (let j = i - 1; j >= 0; j--) {
      // Same high price (exact match to 2 decimal places)
      if (Math.abs(recent[i].high - recent[j].high) < 0.01) {
        return {
          found: true,
          index1: klines.length - recent.length + j,
          index2: klines.length - recent.length + i,
          type: 'high',
          value: recent[i].high,
          description: `对子顶：${recent[j].date} 和 ${recent[i].date} 最高价相同 (${recent[i].high.toFixed(2)})`,
        };
      }

      // Same close price (exact match to 2 decimal places)
      if (Math.abs(recent[i].close - recent[j].close) < 0.01) {
        return {
          found: true,
          index1: klines.length - recent.length + j,
          index2: klines.length - recent.length + i,
          type: 'close',
          value: recent[i].close,
          description: `对子顶：${recent[j].date} 和 ${recent[i].date} 收盘价相同 (${recent[i].close.toFixed(2)})`,
        };
      }
    }
  }

  return { found: false };
}

/**
 * Check the "三合一" condition:
 * 对子顶 + 长上影线 + 放巨量 → 见顶信号
 */
export function checkDuiziDingTriple(klines: Kline[]): {
  triggered: boolean;
  duizi: ReturnType<typeof detectDuiziDing>;
  hasLongUpperShadow: boolean;
  hasHighVolume: boolean;
  description?: string;
} {
  const duizi = detectDuiziDing(klines);

  if (!duizi.found) {
    return { triggered: false, duizi, hasLongUpperShadow: false, hasHighVolume: false };
  }

  // Check last candle for long upper shadow
  const lastCandle = klines[klines.length - 1];
  const upperShadow = lastCandle.high - Math.max(lastCandle.open, lastCandle.close);
  const body = Math.abs(lastCandle.close - lastCandle.open);
  const hasLongUpperShadow = body > 0 && upperShadow > body * 2;

  // Check for high volume (vs 5-day avg)
  const recentVols = klines.slice(-6, -1).map(k => k.volume);
  const avgVol5 = recentVols.reduce((a, b) => a + b, 0) / Math.max(recentVols.length, 1);
  const hasHighVolume = lastCandle.volume > avgVol5 * 1.2;

  const triggered = duizi.found && hasLongUpperShadow && hasHighVolume;

  return {
    triggered,
    duizi,
    hasLongUpperShadow,
    hasHighVolume,
    description: triggered
      ? '⚠️ 对子顶三合一：对子顶 + 长上影线 + 放巨量 → 见顶信号！'
      : `对子顶检测：对子顶=${duizi.found} 长上影=${hasLongUpperShadow} 放量=${hasHighVolume}`,
  };
}
