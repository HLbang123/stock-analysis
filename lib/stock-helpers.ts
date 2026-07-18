import { KLineData, RealtimeQuote } from '@/types';

/**
 * 用实时行情构建"今日 K 线"，并合并进历史 K 线（替换历史中同日数据）
 * 用于规则检测：盘中需以实时价格作为今日 K 线，否则规则会基于过时收盘价
 */
export function buildUpdatedKLines(quote: RealtimeQuote, kLines: KLineData[]): KLineData[] {
  const todayStr = new Date().toISOString().split('T')[0];
  const lastDate = kLines.length > 0 ? kLines[kLines.length - 1].date : '';

  // 最新 K 线已是今天 → 盘中更新：替换最后一根为实时数据
  if (lastDate === todayStr) {
    const historical = kLines.slice(0, -1);
    return [...historical, {
      date: todayStr, open: quote.open, high: quote.high,
      low: quote.low, close: quote.price, volume: quote.volume,
    }];
  }

  // 行情数据包含今日日期（如 "2026-07-18 14:30"）→ 交易日盘中，追加
  if (quote.updateTime && quote.updateTime.startsWith(todayStr)) {
    return [...kLines, {
      date: todayStr, open: quote.open, high: quote.high,
      low: quote.low, close: quote.price, volume: quote.volume,
    }];
  }

  // 行情非今日（周末/节假日）→ 不追加
  return kLines;
}
