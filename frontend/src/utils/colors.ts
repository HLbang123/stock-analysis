/**
 * A-share color convention: RED = up/bullish, GREEN = down/bearish.
 * This is the OPPOSITE of Western markets.
 */

// Tailwind-compatible class helpers
export function priceColor(change: number): string {
  if (change > 0) return 'text-bull';
  if (change < 0) return 'text-bear';
  return 'text-gray-300';
}

export function bgColor(change: number): string {
  if (change > 0) return 'bg-bull/10 border-bull/30';
  if (change < 0) return 'bg-bear/10 border-bear/30';
  return 'bg-gray-500/10 border-gray-500/30';
}

export const CHART_COLORS = {
  // Candlestick
  bullishCandle: '#ef4444',     // red fill
  bearishCandle: '#22c55e',     // green fill
  candleBorder: '#64748b',
  candleWick: '#64748b',

  // MA lines
  ma5: '#f59e0b',    // amber
  ma10: '#3b82f6',   // blue
  ma20: '#a855f7',   // purple

  // Volume
  volumeUp: 'rgba(239, 68, 68, 0.5)',    // semi-transparent red
  volumeDown: 'rgba(34, 197, 94, 0.5)',  // semi-transparent green

  // Chart background
  background: '#0f172a',
  grid: '#1e293b',
  text: '#94a3b8',
  crosshair: '#475569',
};

export const ALERT_COLORS = {
  3: { bg: 'bg-red-500/20', border: 'border-red-500', text: 'text-red-400', label: '🚨 清仓离场' },
  2: { bg: 'bg-orange-500/20', border: 'border-orange-500', text: 'text-orange-400', label: '⚡ 减仓信号' },
  1: { bg: 'bg-green-500/20', border: 'border-green-500', text: 'text-green-400', label: '✅ 买入关注' },
  0: { bg: 'bg-blue-500/20', border: 'border-blue-500', text: 'text-blue-400', label: '🔍 观察提示' },
} as const;
