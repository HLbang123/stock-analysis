import { useMemo } from 'react';
import type { Kline, Alert } from '../types';
import { checkSellRules } from '../engine/rules/sellRules';
import { checkBuyRules } from '../engine/rules/buyRules';
import { checkReverseRules } from '../engine/rules/reverseRules';

export function useAlerts(klines: Kline[], quote: { changePercent: number } | null) {
  return useMemo(() => {
    if (!klines || klines.length < 5) return [];

    const alerts: Alert[] = [
      ...checkSellRules(klines),
      ...checkBuyRules(klines),
      ...checkReverseRules(quote),
    ];

    // Sort by level descending (most severe first)
    return alerts.sort((a, b) => b.level - a.level);
  }, [klines, quote]);
}
