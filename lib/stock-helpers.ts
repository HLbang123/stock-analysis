import { KLineData, KLineSeries, RealtimeQuote } from '@/types';

/**
 * 今日日期字符串（YYYY-MM-DD），按北京时区。
 * 数据源（腾讯/新浪/东财）返回的 date / updateTime 都是北京日期，
 * 之前用 UTC toISOString 会在北京 00:00-08:00 得到前一天（虽然那时盘中无数据，
 * 但用北京时区更正确且与数据源一致）。
 */
export function beijingTodayStr(): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const y = parts.find(p => p.type === 'year')!.value;
  const m = parts.find(p => p.type === 'month')!.value;
  const d = parts.find(p => p.type === 'day')!.value;
  return `${y}-${m}-${d}`;
}

/**
 * 用实时行情构建"今日 K 线"，并合并进历史 K 线（替换历史中同日数据）
 * 用于规则检测：盘中需以实时价格作为今日 K 线，否则规则会基于过时收盘价
 */
export function buildUpdatedKLines(quote: RealtimeQuote, kLines: KLineData[]): KLineData[] {
  const todayStr = beijingTodayStr();
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

/**
 * 把 K 线序列显式拆成"已完成日K"与"盘中合成 bar"。
 *
 * buildUpdatedKLines 在交易日会把盘中价合成成最后一根 bar（date=今日）塞进数组。
 * 不同指标对这根合成 bar 的态度不同：
 *   - RSI / 量能基线 / 箱体：只该用已完成日K（合成 bar 的盘中涨跌/部分成交量会污染）
 *   - MA / MACD / 布林 / BIAS：要用含合成 bar 的序列（同花顺盘中实时跳动）
 * 本函数把"最后一根是否合成 bar"的判断集中到这一处，引擎据此选用 completedBars
 * 或 combinedBars()，不再各自手写 slice(0,-1) / date===today 防御。
 *
 * 判定：最后一根 date === 今日(北京) 即视为合成 bar。盘后今日 bar 已收盘但仍会被
 * 剥离（pre-existing 行为，保持不回归；集中后可单独优化）。
 */
export function splitKLines(kLines: KLineData[]): KLineSeries {
  if (kLines.length === 0) return { completedBars: [], intradayBar: null };
  const todayStr = beijingTodayStr();
  const last = kLines[kLines.length - 1];
  if (last.date === todayStr) {
    return { completedBars: kLines.slice(0, -1), intradayBar: last };
  }
  return { completedBars: kLines, intradayBar: null };
}

/** 合并回含盘中合成 bar 的完整序列（供 MA/MACD/布林 等盘中实时指标使用）。 */
export function combinedBars(s: KLineSeries): KLineData[] {
  return s.intradayBar ? [...s.completedBars, s.intradayBar] : s.completedBars;
}
