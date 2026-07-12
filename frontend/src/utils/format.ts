/**
 * Number formatting utilities for stock display.
 */

export function formatPrice(price: number, decimals = 2): string {
  if (price === 0) return '-';
  return price.toFixed(decimals);
}

export function formatChange(change: number, decimals = 2): string {
  const sign = change > 0 ? '+' : '';
  return `${sign}${change.toFixed(decimals)}`;
}

export function formatPercent(pct: number, decimals = 2): string {
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(decimals)}%`;
}

export function formatVolume(vol: number): string {
  if (vol >= 100000000) return `${(vol / 100000000).toFixed(2)}亿`;
  if (vol >= 10000) return `${(vol / 10000).toFixed(0)}万`;
  return vol.toFixed(0);
}

export function formatAmount(amount: number): string {
  if (amount >= 100000000) return `${(amount / 100000000).toFixed(2)}亿`;
  if (amount >= 10000) return `${(amount / 10000).toFixed(0)}万`;
  return amount.toFixed(0);
}

export function formatDate(date: string): string {
  if (date.length === 8) {
    return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  }
  return date;
}
