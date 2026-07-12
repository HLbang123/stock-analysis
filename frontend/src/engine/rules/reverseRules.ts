import type { Alert } from '../../types';

let alertId = 0;

/**
 * Reverse indicators / contrarian signals.
 *
 * From the document: "妇联定律" — when 工业富联 (601138) surges >8%,
 * it often signals a tech sector peak and upcoming correction.
 */
export function checkReverseRules(quote: { changePercent: number } | null): Alert[] {
  const alerts: Alert[] = [];

  // This requires checking a specific stock (工业富联 601138).
  // In the full app, this would watch 601138 independently.
  // For now, this is a placeholder that demonstrates the concept.

  // The actual check happens at the app level —
  // we'd need to poll 601138 separately and broadcast a warning.

  return alerts;
}

/**
 * Check if Industrial Fulian (601138) is surging.
 * Call this separately with 601138's quote data.
 */
export function checkIndustrialFulian(quote: { changePercent: number; price: number; name: string }): Alert[] {
  if (quote.changePercent > 8) {
    return [{
      id: 'reverse-fulian',
      level: 2,
      category: 'reverse',
      rule: '妇联定律 — 工业富联大涨>8%',
      description: `工业富联涨幅 ${quote.changePercent.toFixed(1)}%，历史统计表明往往对应科技股情绪顶峰`,
      action: '警惕科技板块即将迎来大分歧，建议谨慎减仓',
      timestamp: new Date().toISOString(),
    }];
  }
  return [];
}
