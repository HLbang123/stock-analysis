import type { Kline } from '../../types';
import { calcMACD, findMACDDivergence } from '../indicators/macd';
import { calcRSI } from '../indicators/rsi';

/**
 * Check for bottom divergence (底背离) on 30min or daily K-lines.
 *
 * From the document: "上证指数在30分钟形成了底背离，说明点位虽然更低了，
 * 但是明显有大量资金来抄底了。"
 *
 * Divergence = price makes lower low, but indicator makes higher low.
 */
export function detectBottomDivergence(klines: Kline[]): {
  found: boolean;
  macdDivergence: boolean;
  rsiDivergence: boolean;
  description?: string;
} {
  if (klines.length < 26) return { found: false, macdDivergence: false, rsiDivergence: false };

  const closes = klines.map(k => k.close);
  const { dif } = calcMACD(closes);
  const rsi = calcRSI(closes);

  // Check MACD divergence
  const macdDiv = findMACDDivergence(closes, dif, 20);

  let macdDivergence = false;
  let rsiDivergence = false;

  // MACD bullish divergence near end
  if (macdDiv.bullish.length > 0) {
    const lastDiv = macdDiv.bullish[macdDiv.bullish.length - 1];
    if (lastDiv >= klines.length - 5) {
      macdDivergence = true;
    }
  }

  // RSI divergence check
  if (rsi.length > 20) {
    // Find last two local price lows and corresponding RSI values
    const recent20Prices = closes.slice(-20);
    const recent20RSI = rsi.slice(-20).filter(v => v !== null) as number[];

    // Simple check: price declining but RSI rising
    const firstHalfPrice = recent20Prices.slice(0, 10).reduce((a, b) => a + b, 0) / 10;
    const secondHalfPrice = recent20Prices.slice(-10).reduce((a, b) => a + b, 0) / 10;

    const firstHalfRSI = recent20RSI.slice(0, Math.min(10, recent20RSI.length)).reduce((a, b) => a + b, 0) / Math.min(10, recent20RSI.length);
    const secondHalfRSI = recent20RSI.slice(-10).reduce((a, b) => a + b, 0) / 10;

    if (secondHalfPrice < firstHalfPrice && secondHalfRSI > firstHalfRSI) {
      rsiDivergence = true;
    }
  }

  const found = macdDivergence || rsiDivergence;
  const parts: string[] = [];
  if (macdDivergence) parts.push('MACD底背离');
  if (rsiDivergence) parts.push('RSI底背离');

  return {
    found,
    macdDivergence,
    rsiDivergence,
    description: found ? `底背离信号：${parts.join('、')} — 资金抄底迹象` : undefined,
  };
}

/**
 * Check for top divergence (顶背离).
 */
export function detectTopDivergence(klines: Kline[]): {
  found: boolean;
  macdDivergence: boolean;
  description?: string;
} {
  if (klines.length < 26) return { found: false, macdDivergence: false };

  const closes = klines.map(k => k.close);
  const { dif } = calcMACD(closes);
  const macdDiv = findMACDDivergence(closes, dif, 20);

  let macdDivergence = false;
  if (macdDiv.bearish.length > 0) {
    const lastDiv = macdDiv.bearish[macdDiv.bearish.length - 1];
    if (lastDiv >= klines.length - 5) {
      macdDivergence = true;
    }
  }

  return {
    found: macdDivergence,
    macdDivergence,
    description: macdDivergence ? 'MACD顶背离 — 上涨动能减弱' : undefined,
  };
}
