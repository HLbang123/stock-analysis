import { KLineData, RealtimeQuote, AlertRule, RuleCheckResult } from '@/types';

/**
 * 辅助函数：计算移动平均线
 */
function calculateMA(kLines: KLineData[], period: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < kLines.length; i++) {
    if (i < period - 1) {
      result.push(0);
    } else {
      const slice = kLines.slice(i - period + 1, i + 1);
      const avg = slice.reduce((sum, k) => sum + k.close, 0) / period;
      result.push(avg);
    }
  }
  return result;
}

/**
 * 辅助函数：计算平均成交量
 */
function calculateAvgVolume(kLines: KLineData[], period: number): number {
  if (kLines.length < period) return 0;
  const slice = kLines.slice(-period);
  return slice.reduce((sum, k) => sum + k.volume, 0) / period;
}

/**
 * 辅助函数：计算最大成交量
 */
function calculateMaxVolume(kLines: KLineData[], period: number): number {
  if (kLines.length < period) return 0;
  const slice = kLines.slice(-period);
  return Math.max(...slice.map(k => k.volume));
}

/**
 * 辅助函数：计算涨跌幅
 */
function calculateChangePercent(current: number, prev: number): number {
  return ((current - prev) / prev) * 100;
}

/**
 * 计算上影线百分比（相对于收盘价，与Android一致）
 */
function calculateUpperShadowPercent(k: KLineData): number {
  const bodyTop = Math.max(k.open, k.close);
  if (k.close === 0) return 0;
  return ((k.high - bodyTop) / k.close) * 100;
}

/**
 * 计算下影线百分比（相对于收盘价，与Android一致）
 */
function calculateLowerShadowPercent(k: KLineData): number {
  const bodyBottom = Math.min(k.open, k.close);
  if (k.close === 0) return 0;
  return ((bodyBottom - k.low) / k.close) * 100;
}

/**
 * 计算 RSI（Wilder's smoothing 方法）
 */
function calculateRSI(kLines: KLineData[], period: number = 6): number {
  if (kLines.length < period + 1) return 50;
  const changes: number[] = [];
  for (let i = kLines.length - period; i < kLines.length; i++) {
    changes.push(kLines[i].close - kLines[i - 1].close);
  }
  const gains = changes.map(c => c > 0 ? c : 0);
  const losses = changes.map(c => c < 0 ? -c : 0);
  const avgGain = gains.reduce((a, b) => a + b, 0) / period;
  const avgLoss = losses.reduce((a, b) => a + b, 0) / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

/**
 * 计算指定周期内最大回撤（百分比）
 */
function calculateMaxDrawdown(kLines: KLineData[], period: number): number {
  if (kLines.length < period) return 0;
  const segment = kLines.slice(-period);
  let peak = segment[0].high;
  let maxDD = 0;
  for (const k of segment) {
    if (k.high > peak) peak = k.high;
    const dd = (peak - k.low) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

/**
 * 统计指定周期内涨幅超过阈值的阳线数量
 */
function countBigYangLines(kLines: KLineData[], period: number, threshold: number = 3.0): number {
  if (kLines.length < period + 1) return 0;
  let count = 0;
  for (let i = kLines.length - period; i < kLines.length; i++) {
    const change = calculateChangePercent(kLines[i].close, kLines[i - 1].close);
    if (change > threshold) count++;
  }
  return count;
}

/**
 * 统计指定周期内跌幅超过阈值的阴线数量
 */
function countBigYinLines(kLines: KLineData[], period: number, threshold: number = 3.0): number {
  if (kLines.length < period + 1) return 0;
  let count = 0;
  for (let i = kLines.length - period; i < kLines.length; i++) {
    const change = calculateChangePercent(kLines[i].close, kLines[i - 1].close);
    if (change < -threshold) count++;
  }
  return count;
}

/**
 * 计算指定周期箱体范围
 */
function getBoxRange(kLines: KLineData[], period: number): { high: number; low: number; range: number } {
  const segment = kLines.slice(-period);
  const high = Math.max(...segment.map(k => k.high));
  const low = Math.min(...segment.map(k => k.low));
  const range = (high - low) / low;
  return { high, low, range };
}

/**
 * 快线下穿慢线是否在最近 within 根内发生，且当前仍处于快线<慢线状态。
 * 用于检测均线死叉（含扫描隔日补检的容错窗口）。
 */
function crossedBelowWithin(maFast: number[], maSlow: number[], idx: number, within: number): boolean {
  if (maFast[idx] >= maSlow[idx]) return false;
  for (let i = idx; i > idx - within && i >= 1; i--) {
    if (maFast[i - 1] >= maSlow[i - 1] && maFast[i] < maSlow[i]) return true;
  }
  return false;
}

/**
 * 快线上穿慢线是否在最近 within 根内发生，且当前仍处于快线>慢线状态。用于检测金叉。
 */
function crossedAboveWithin(maFast: number[], maSlow: number[], idx: number, within: number): boolean {
  if (maFast[idx] <= maSlow[idx]) return false;
  for (let i = idx; i > idx - within && i >= 1; i--) {
    if (maFast[i - 1] <= maSlow[i - 1] && maFast[i] > maSlow[i]) return true;
  }
  return false;
}

/**
 * 价格下穿某均线是否在最近 within 根内发生，且当前仍处于价格<均线状态。
 */
function priceCrossedBelowWithin(kLines: KLineData[], ma: number[], idx: number, within: number): boolean {
  if (kLines[idx].close >= ma[idx]) return false;
  for (let i = idx; i > idx - within && i >= 1; i--) {
    if (kLines[i - 1].close >= ma[i - 1] && kLines[i].close < ma[i]) return true;
  }
  return false;
}

// ==================== 规则检查器 ====================

/**
 * R001: 巨量预警 - 当日成交量 > 近5日均量 × 1.20
 */
function checkVolumeRule(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 6) return { triggered: false };
  const idx = kLines.length - 1;
  const today = kLines[idx];
  const avg5 = calculateAvgVolume(kLines.slice(0, -1), 5);
  const threshold = rule.thresholdValue ?? 1.20;

  if (avg5 > 0 && today.volume > avg5 * threshold) {
    return {
      triggered: true,
      ruleId: 'R001',
      message: `⚠️ 巨量预警：成交量 ${today.volume}，近5日均量 ${Math.round(avg5)}，放量 ${Math.round(today.volume / avg5 * 100 - 100)}%`,
      extraData: JSON.stringify({ todayVol: today.volume }),
      barIndex: idx
    };
  }
  return { triggered: false };
}

/**
 * R002: 巨量见顶 - 成交量 = 近一年最大量 或 > 近5日高点 × 1.2
 */
function checkVolumePeak(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 10) return { triggered: false };
  const idx = kLines.length - 1;
  const today = kLines[idx];
  const maxYear = Math.max(...kLines.map(k => k.volume));
  const max5 = calculateMaxVolume(kLines.slice(0, -1), 5);

  if (today.volume >= maxYear * 0.95 || (max5 > 0 && today.volume > max5 * 1.2)) {
    return {
      triggered: true,
      ruleId: 'R002',
      message: `🔴 巨量见顶：成交量 ${today.volume}，5日最高 ${max5}，年最高 ${maxYear}`,
      extraData: JSON.stringify({ todayVol: today.volume }),
      barIndex: idx
    };
  }
  return { triggered: false };
}

/**
 * R003: 长上影线 - 上影线 > 3% 且 急拉缓跌。若同时放量升级为CRITICAL
 */
function checkLongUpperShadow(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 4) return { triggered: false };
  const idx = kLines.length - 1;
  const today = kLines[idx];
  const upperShadow = calculateUpperShadowPercent(today);

  const prev1 = kLines[idx - 1];
  const prev2 = kLines[idx - 2];
  const prevChange = calculateChangePercent(prev1.close, prev2.close);
  const todayChange = calculateChangePercent(today.close, prev1.close);

  if (upperShadow > 3.0 && prevChange > 3 && todayChange < prevChange - 2) {
    const avg5 = calculateAvgVolume(kLines.slice(0, -1), 5);
    const isHighVol = today.volume > avg5 * 1.2;
    const level = isHighVol ? 'CRITICAL' : 'WARNING';
    const prefix = isHighVol ? '🔴' : '⚠️';
    const volNote = isHighVol ? ' + 放量！' : '';
    return {
      triggered: true,
      ruleId: 'R003',
      message: `${prefix} 冲高回落${level === 'CRITICAL' ? '（放量见顶）' : ''}：上影线 ${upperShadow.toFixed(2)}%，涨幅 ${todayChange.toFixed(2)}%${volNote}`,
      extraData: JSON.stringify({ shadow: upperShadow, isHighVol }),
      barIndex: idx
    };
  }
  return { triggered: false };
}

/**
 * R004: 破五日线 - 收盘跌破MA5且放量。量比>2升级为CRITICAL
 */
function checkBreakMa5(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 6) return { triggered: false };
  const idx = kLines.length - 1;
  const today = kLines[idx];
  const ma5 = calculateMA(kLines, 5)[idx];
  const prev1 = kLines[idx - 1];
  const avg5 = calculateAvgVolume(kLines.slice(0, -1), 5);
  const volRatio = avg5 > 0 ? today.volume / avg5 : 1;

  if (today.close < ma5 && today.volume > prev1.volume * 1.1) {
    const isCritical = volRatio > 2.0;
    return {
      triggered: true,
      ruleId: 'R004',
      message: `${isCritical ? '🔴' : '⚠️'} 破五日线：收盘 ${today.close}，MA5 ${ma5.toFixed(2)}，放量跌破${isCritical ? '（量比>2，强烈离场信号！）' : ''}`,
      extraData: JSON.stringify({ close: today.close, volRatio }),
      barIndex: idx
    };
  }
  return { triggered: false };
}

/**
 * R005: 破趋势线 - 收<10日低点均线+放量。同步跌破MA60升级为强信号
 */
function checkBreakTrendLine(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 60) return { triggered: false };
  const idx = kLines.length - 1;
  const today = kLines[idx];
  const recent10 = kLines.slice(-10);
  const trendLine = recent10.reduce((sum, k) => sum + k.low, 0) / 10;
  const prev1 = kLines[idx - 1];

  if (today.close < trendLine && prev1.close < trendLine && today.volume > prev1.volume * 1.05) {
    const ma60Arr = calculateMA(kLines, 60);
    const ma60 = ma60Arr[idx];
    const belowMA60 = ma60 > 0 && today.close < ma60;
    return {
      triggered: true,
      ruleId: 'R005',
      message: belowMA60
        ? `🔴🔴 破趋势线+破MA60：收盘 ${today.close}，趋势支撑 ${trendLine.toFixed(2)}，MA60 ${ma60.toFixed(2)}——牛熊分界已破，观望！`
        : `🔴 破趋势线：收盘 ${today.close}，趋势支撑 ${trendLine.toFixed(2)}`,
      extraData: JSON.stringify({ close: today.close, belowMA60, ma60: ma60 || 0 }),
      barIndex: idx
    };
  }
  return { triggered: false };
}

/**
 * R006: 超大阳线 > 5.5%
 */
function checkBigYangLine(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 2) return { triggered: false };
  const idx = kLines.length - 1;
  const today = kLines[idx];
  const prev1 = kLines[idx - 1];
  const change = calculateChangePercent(today.close, prev1.close);

  if (change > 5.5) {
    return {
      triggered: true,
      ruleId: 'R006',
      message: `⚠️ 超大阳线：涨幅 ${change.toFixed(2)}%，考虑止盈`,
      extraData: JSON.stringify({ change }),
      barIndex: idx
    };
  }
  return { triggered: false };
}

/**
 * R007: 连阳预警
 */
function checkConsecutiveYang(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 4) return { triggered: false };
  const idx = kLines.length - 1;

  const c3 = kLines[idx - 3];
  const c2 = kLines[idx - 2];
  const c1 = kLines[idx];

  const chg3to2 = calculateChangePercent(c2.close, c3.close);
  const chg2to1 = calculateChangePercent(c1.close, c2.close);

  if (chg3to2 > 0 && chg2to1 > 0 && chg3to2 >= 3.0 && chg3to2 <= 5.5 && chg2to1 >= 3.0 && chg2to1 <= 5.5) {
    return {
      triggered: true,
      ruleId: 'R007',
      message: `⚠️ 连阳预警：连续大涨 ${chg3to2.toFixed(2)}%, ${chg2to1.toFixed(2)}%`,
      extraData: JSON.stringify({ chg2: chg3to2 }),
      barIndex: idx
    };
  }

  // 检查三连阳
  if (idx >= 3) {
    const chg4to3 = calculateChangePercent(c3.close, kLines[idx - 4].close);
    if (chg4to3 > 0 && chg3to2 > 0 && chg2to1 > 0) {
      return {
        triggered: true,
        ruleId: 'R007',
        message: '⚠️ 三连阳：连续3天上涨，考虑逐步止盈',
        extraData: '{}',
        barIndex: idx
      };
    }
  }
  return { triggered: false };
}

/**
 * R008: 妇联定律
 */
function checkFuliLaw(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (quote?.code !== 'sh601138') return { triggered: false };

  const change = quote.changePercent;
  if (change > 8.0) {
    return {
      triggered: true,
      ruleId: 'R008',
      message: `🔴 妇联定律：工业富联大涨 ${change.toFixed(2)}%，警惕科技板块大分歧！`,
      extraData: JSON.stringify({ change })
    };
  }
  return { triggered: false };
}

/**
 * R009: 第二波见顶
 */
function checkSecondWaveVolume(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 60) return { triggered: false };
  const idx = kLines.length - 1;

  const firstWaveMax = Math.max(...kLines.slice(0, -1).map(k => k.volume));
  const recentMax = Math.max(...kLines.slice(-10).map(k => k.volume));

  if (firstWaveMax > 0 && recentMax >= firstWaveMax * 0.9) {
    return {
      triggered: true,
      ruleId: 'R009',
      message: `🔴 第二波见顶：近期量 ${recentMax} 接近第一波高潮 ${firstWaveMax}`,
      extraData: JSON.stringify({ recentMax }),
      barIndex: idx
    };
  }
  return { triggered: false };
}

/**
 * R010: 急跌预警
 */
function checkSuddenDrop(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 2) return { triggered: false };
  const idx = kLines.length - 1;
  const today = kLines[idx];
  const prev1 = kLines[idx - 1];
  const change = calculateChangePercent(today.close, prev1.close);

  if (change < -7.0) {
    return {
      triggered: true,
      ruleId: 'R010',
      message: `🔴 急跌预警：暴跌 ${change.toFixed(2)}%，先抛再说！`,
      extraData: JSON.stringify({ change }),
      barIndex: idx
    };
  }
  return { triggered: false };
}

/**
 * R011: 反包入场
 */
function checkReboundEntry(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 20) return { triggered: false };
  const idx = kLines.length - 1;

  const recent15 = kLines.slice(-15);
  const today = kLines[idx];
  const prev1 = kLines[idx - 1];
  const change = calculateChangePercent(today.close, prev1.close);

  const recentMin = Math.min(...recent15.map(k => k.low));
  const recentMaxBefore = Math.max(...recent15.slice(0, -1).map(k => k.high));
  const hasPullback = (recentMaxBefore - recentMin) / recentMaxBefore > 0.05;

  if (change >= 5.0 && hasPullback && today.close >= recentMaxBefore * 0.98) {
    return {
      triggered: true,
      ruleId: 'R011',
      message: `🟢 反包入场：大涨 ${change.toFixed(2)}%，W型/C浪企稳反包`,
      extraData: JSON.stringify({ change }),
      barIndex: idx
    };
  }
  return { triggered: false };
}

/**
 * R012: 箱体吸筹
 */
function checkBoxAccumulation(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 60) return { triggered: false };
  const idx = kLines.length - 1;

  const recent60 = kLines.slice(-60);
  const boxHigh = Math.max(...recent60.map(k => k.high));
  const boxLow = Math.min(...recent60.map(k => k.low));
  const boxRange = (boxHigh - boxLow) / boxLow;

  if (boxRange > 0.20) return { triggered: false };

  const today = kLines[idx];
  const prev1 = kLines[idx - 1];
  const change = calculateChangePercent(today.close, prev1.close);
  const avgVol = calculateAvgVolume(kLines.slice(0, -1), 20);

  if (change >= 1.0 && change <= 4.0 && today.volume > avgVol * 1.3) {
    return {
      triggered: true,
      ruleId: 'R012',
      message: `🟢 箱体吸筹：放量小阳线 ${change.toFixed(2)}%，关注标的`,
      extraData: JSON.stringify({ change }),
      barIndex: idx
    };
  }
  return { triggered: false };
}

/**
 * R013: 缩量破位 - 缩量跌破MA5。注：缩量阴线可能是健康调整，只有趋势也破位才减仓
 */
function checkLowVolBreak(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 6) return { triggered: false };
  const idx = kLines.length - 1;

  const today = kLines[idx];
  const prev1 = kLines[idx - 1];
  const ma5 = calculateMA(kLines, 5)[idx];

  if (today.close < ma5 && today.volume < prev1.volume * 0.9) {
    // 检查趋势是否同步破位（连续两日收<MA5）
    const prevBelowMA5 = prev1.close < calculateMA(kLines, 5)[idx - 1];
    const trendBroken = prevBelowMA5;
    return {
      triggered: true,
      ruleId: 'R013',
      message: trendBroken
        ? `🟡 缩量破位（趋势确认）：连续两日收<MA5，缩量${today.close < prev1.close ? '阴跌' : ''}，减仓观望`
        : `ℹ️ 缩量破MA5：收 ${today.close} < MA5 ${ma5.toFixed(2)}，但缩量可能是健康调整，关注趋势是否同步破位`,
      extraData: JSON.stringify({ trendBroken }),
      barIndex: idx
    };
  }
  return { triggered: false };
}

/**
 * R014: 对子顶
 */
function checkDoubleTop(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 5) return { triggered: false };
  const idx = kLines.length - 1;

  const today = kLines[idx];
  const prev1 = kLines[idx - 1];

  const highMatch = Math.abs(today.high - prev1.high) / prev1.high < 0.001;
  const closeMatch = Math.abs(today.close - prev1.close) / prev1.close < 0.001;
  const upperShadow = calculateUpperShadowPercent(today);

  if ((highMatch || closeMatch) && upperShadow > 2.5 && today.volume > calculateAvgVolume(kLines.slice(0, -1), 5) * 1.2) {
    return {
      triggered: true,
      ruleId: 'R014',
      message: `🔴 对子顶：高点/收盘接近+上影 ${upperShadow.toFixed(1)}% + 放量！`,
      extraData: '{}',
      barIndex: idx
    };
  }
  return { triggered: false };
}

/**
 * R015: 止跌企稳 - 前15日有抛压释放（>10%跌幅）+ 新低区域经典锤子线/十字星
 * 锤子线标准：下影≥实体×2 + 上影<1% + 下影绝对值>2%
 */
function checkBottomStabilize(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 15) return { triggered: false };
  const idx = kLines.length - 1;

  const today = kLines[idx];
  const min15Low = Math.min(...kLines.slice(-15).map(k => k.low));

  if (today.low > min15Low * 1.005) return { triggered: false };

  // 前置条件：前15日抛压是否充分释放（>10%跌幅）
  const prev15High = Math.max(...kLines.slice(-15, -1).map(k => k.high));
  const prev15Min = Math.min(...kLines.slice(-15, -1).map(k => k.low));
  const dropRange = (prev15High - prev15Min) / prev15High;
  if (dropRange < 0.10) return { triggered: false };

  const lowerShadowPct = calculateLowerShadowPercent(today);
  const upperShadowPct = calculateUpperShadowPercent(today);
  const body = Math.abs(today.close - today.open);
  const lowerShadowAbs = Math.min(today.open, today.close) - today.low;
  const isDoji = body / today.open < 0.005;

  // 经典锤子线判定：下影 ≥ 实体×2 + 下影>2% + 上影<1%（近乎光头）
  const isHammer = body > 0 && lowerShadowAbs >= body * 2 && lowerShadowPct > 2.0 && upperShadowPct < 1.0;

  let sig = '';
  if (isHammer) sig = `锤子线（下影${lowerShadowPct.toFixed(1)}%，实体${(body/today.open*100).toFixed(1)}%）`;
  else if (isDoji) sig = '十字星';

  if (sig) {
    return {
      triggered: true,
      ruleId: 'R015',
      message: `🟢 止跌企稳：抛压已释放 ${(dropRange * 100).toFixed(0)}%，新低区域出现${sig}，关注低吸`,
      extraData: JSON.stringify({ dropRange, lowerShadowPct, isHammer }),
      barIndex: idx
    };
  }
  return { triggered: false };
}

/**
 * R016: 黄金位反弹
 */
function checkGoldenRebound(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 30) return { triggered: false };
  const idx = kLines.length - 1;

  const recent30 = kLines.slice(-30);
  const high = Math.max(...recent30.map(k => k.high));
  const low = Math.min(...recent30.map(k => k.low));

  if ((high - low) / low < 0.10) return { triggered: false };

  const today = kLines[idx];
  const prev1 = kLines[idx - 1];
  const ratio = (today.close - low) / (high - low);
  const change = calculateChangePercent(today.close, prev1.close);

  if (ratio >= 0.382 && ratio <= 0.618 && change > 3.0 && today.volume > prev1.volume * 1.2) {
    return {
      triggered: true,
      ruleId: 'R016',
      message: `🟢 黄金位反弹：回调至 ${(ratio * 100).toFixed(0)}% + 放量阳线 ${change.toFixed(1)}%`,
      extraData: '{}',
      barIndex: idx
    };
  }
  return { triggered: false };
}

/**
 * R017: 横盘滞涨
 */
function checkSideways(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 5) return { triggered: false };
  const idx = kLines.length - 1;

  const recent5 = kLines.slice(-5);
  const range5 = (Math.max(...recent5.map(k => k.high)) - Math.min(...recent5.map(k => k.low))) / Math.min(...recent5.map(k => k.low));
  const change5 = calculateChangePercent(recent5[4].close, recent5[0].close);

  if (range5 < 0.05 && Math.abs(change5) < 2.0) {
    return {
      triggered: true,
      ruleId: 'R017',
      message: `🟡 横盘滞涨：振幅 ${(range5 * 100).toFixed(1)}%，防止利润回吐`,
      extraData: '{}',
      barIndex: idx
    };
  }
  return { triggered: false };
}

// ==================== 心姐 1.0 版新增规则 ====================

/**
 * R018: RSI 超卖（R0100）— RSI(6) < 20 进入超卖区，适合低吸
 * PDF来源：ART026，A级可信度 | 归属：技术分析师
 */
function checkRSIOversold(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 10) return { triggered: false };
  const idx = kLines.length - 1;
  const rsi6 = calculateRSI(kLines, 6);

  if (rsi6 < 20) {
    return {
      triggered: true,
      ruleId: 'R018',
      message: `🟢 RSI超卖：RSI(6)=${rsi6.toFixed(1)} < 20，进入超卖区，适合逢低布局`,
      extraData: JSON.stringify({ rsi6 }),
      barIndex: idx
    };
  }
  return { triggered: false };
}

/**
 * R019: RSI 底背离（R0101）— 价格新低但 RSI 未新低
 * PDF来源：ART026，A级可信度 | 归属：技术分析师
 */
function checkRSIDivergence(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 15) return { triggered: false };
  const idx = kLines.length - 1;

  // 最近5日价格新低
  const recent5 = kLines.slice(-5);
  const recent5Min = Math.min(...recent5.map(k => k.low));
  const prev15Min = Math.min(...kLines.slice(-20, -5).map(k => k.low));
  const isPriceNewLow = recent5Min < prev15Min * 0.98;

  if (!isPriceNewLow) return { triggered: false };

  // 比较 RSI：最近5日最低RSI vs 前段最低RSI
  const rsiNow = calculateRSI(kLines.slice(0, idx + 1), 6);
  const rsiPrev = calculateRSI(kLines.slice(0, idx - 4), 6);

  if (rsiNow > rsiPrev * 1.05) {
    return {
      triggered: true,
      ruleId: 'R019',
      message: `🟢 RSI底背离：价格创近期新低，但RSI(6)=${rsiNow.toFixed(1)} 未同步新低（前值${rsiPrev.toFixed(1)}），买入信号`,
      extraData: JSON.stringify({ rsiNow, rsiPrev }),
      barIndex: idx
    };
  }
  return { triggered: false };
}

/**
 * R020: 放量离场（R0720）— 量比 > 2倍均值 且 价格破位
 * PDF来源：ART141，A级可信度 | 归属：风控专家
 */
function checkVolumeSurgeExit(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 6) return { triggered: false };
  const idx = kLines.length - 1;
  const today = kLines[idx];
  const avg5 = calculateAvgVolume(kLines.slice(0, -1), 5);
  if (avg5 === 0) return { triggered: false };

  const volRatio = today.volume / avg5;
  if (volRatio < 2.0) return { triggered: false };

  // 价格破位：收<MA5 或 收<10日低点均线
  const ma5 = calculateMA(kLines, 5)[idx];
  const ma10Low = kLines.slice(-10).reduce((s, k) => s + k.low, 0) / 10;
  const priceBreak = today.close < ma5 || today.close < ma10Low;

  if (priceBreak) {
    return {
      triggered: true,
      ruleId: 'R020',
      message: `🔴 放量离场：量比 ${volRatio.toFixed(1)}倍 + 价格破位（收${today.close}），果断离场！`,
      extraData: JSON.stringify({ volRatio, close: today.close }),
      barIndex: idx
    };
  }
  return { triggered: false };
}

/**
 * R021: 缩量阴线健康（R0669）— 阴线但缩量 + 趋势未破，可能是健康调整
 * PDF来源：ART132，B级可信度 | 归属：技术分析师
 */
function checkHealthyPullback(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 6) return { triggered: false };
  const idx = kLines.length - 1;
  const today = kLines[idx];
  const prev1 = kLines[idx - 1];

  // 阴线
  if (today.close >= today.open) return { triggered: false };
  // 缩量
  if (today.volume >= prev1.volume * 0.9) return { triggered: false };
  // 趋势未破：收 > MA10
  const ma10 = calculateMA(kLines, 10)[idx];
  if (ma10 === 0 || today.close <= ma10) return { triggered: false };

  return {
    triggered: true,
    ruleId: 'R021',
    message: `ℹ️ 缩量阴线健康：阴线但缩量（量${today.volume}<前日${prev1.volume}），收${today.close}>MA10(${ma10.toFixed(2)})，趋势完好，可能是洗盘`,
    extraData: '{}',
    barIndex: idx
  };
}

/**
 * R022: 大阳调整健康（R0222/R0232）— 近期涨幅>3%的大阳线 ≤ 2根，调整幅度可控
 * PDF来源：ART058，B级可信度 | 归属：技术分析师
 */
function checkBigYangAdjustment(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 12) return { triggered: false };
  const idx = kLines.length - 1;
  const bigYangCount = countBigYangLines(kLines, 10, 3.0);

  if (bigYangCount <= 2 && bigYangCount > 0) {
    // 确认当前处于调整状态（近3日累计涨跌 < 2%）
    const recent3Change = calculateChangePercent(kLines[idx].close, kLines[idx - 3].close);
    if (Math.abs(recent3Change) < 2.0) {
      return {
        triggered: true,
        ruleId: 'R022',
        message: `ℹ️ 大阳调整健康：近10日大阳线${bigYangCount}根（≤2根），调整充分，关注再次启动`,
        extraData: JSON.stringify({ bigYangCount }),
        barIndex: idx
      };
    }
  }
  return { triggered: false };
}

/**
 * R023: 箱体突破（R0260）— 40日振幅<20% + 突破上沿>3% + 放量
 * PDF来源：ART061，D级（实验性规则，箱体参数为推导值）
 * 归属：技术分析师
 */
function checkBoxBreakout(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 42) return { triggered: false };
  const idx = kLines.length - 1;
  const today = kLines[idx];

  const { high, range } = getBoxRange(kLines.slice(0, -1), 40);
  if (range > 0.20) return { triggered: false };

  // 突破上沿 > 3%
  const breakoutPct = (today.close - high) / high * 100;
  if (breakoutPct < 3.0) return { triggered: false };

  // 放量确认
  const avgVol20 = calculateAvgVolume(kLines.slice(0, -1), 20);
  if (today.volume < avgVol20 * 1.2) return { triggered: false };

  return {
    triggered: true,
    ruleId: 'R023',
    message: `🟢 箱体突破（实验性）：40日箱体上沿${high.toFixed(2)}，突破${breakoutPct.toFixed(1)}% + 放量确认`,
    extraData: JSON.stringify({ boxHigh: high, breakoutPct }),
    barIndex: idx
  };
}

/**
 * R024: 选股-价格位置 — 当前价 > 120日最低价 × 2.5
 * PDF来源：选股三原则（ART009），A级可信度 | 归属：心姐
 */
function checkPricePosition(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 120) return { triggered: false };
  const idx = kLines.length - 1;
  const today = kLines[idx];

  const min120Low = Math.min(...kLines.slice(-120).map(k => k.low));
  const ratio = today.close / min120Low;

  if (ratio > 2.5) {
    return {
      triggered: true,
      ruleId: 'R024',
      message: `⚠️ 选股-价格位：当前价是半年前低点的 ${ratio.toFixed(1)} 倍（>2.5），不符合心姐选股标准`,
      extraData: JSON.stringify({ ratio, min120Low }),
      barIndex: idx
    };
  }
  return { triggered: false };
}

/**
 * R025: 选股-资金面 — 两周内最大回撤>50% 或 前方多根大阴线
 * PDF来源：选股三原则（ART009），A级可信度 | 归属：心姐
 */
function checkCapitalStatus(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 20) return { triggered: false };
  const idx = kLines.length - 1;

  const maxDD = calculateMaxDrawdown(kLines.slice(0, -1), 10);
  const bigYinCount = countBigYinLines(kLines.slice(0, -1), 20, 3.0);

  if (maxDD > 0.50 || bigYinCount > 3) {
    const reasons: string[] = [];
    if (maxDD > 0.50) reasons.push(`两周回撤${(maxDD * 100).toFixed(0)}%（>50%）`);
    if (bigYinCount > 3) reasons.push(`前方${bigYinCount}根大阴线（>3根）`);
    return {
      triggered: true,
      ruleId: 'R025',
      message: `⚠️ 选股-资金面：${reasons.join('，')}，抛压过大，不符合心姐选股标准`,
      extraData: JSON.stringify({ maxDD, bigYinCount }),
      barIndex: idx
    };
  }
  return { triggered: false };
}

/**
 * R026: 选股-基本面 — PE > 行业平均×1.5 或 净利润增速 < 0
 * PDF来源：选股三原则（ART009），A级可信度 | 归属：心姐
 * 注：需要 Tushare 基本面数据，无数据时不触发
 */
function checkFundamentalFilter(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  // 基本面数据需要从外部注入，这里仅做占位检查
  // 实际数据通过 quote 或其他渠道获取
  if (!quote) return { triggered: false };

  // 检查 extraData 中是否有 PE/利润数据
  let pe = 0, profitGrowth = 0, industryPE = 0;
  try {
    const extra = rule as any;
    if (extra?._fundamentalData) {
      pe = extra._fundamentalData.pe || 0;
      profitGrowth = extra._fundamentalData.profitGrowth || 0;
      industryPE = extra._fundamentalData.industryPE || 0;
    }
  } catch { return { triggered: false }; }

  if (pe === 0) return { triggered: false };

  const peFlag = industryPE > 0 && pe > industryPE * 1.5;
  const profitFlag = profitGrowth < 0;

  if (peFlag || profitFlag) {
    const reasons: string[] = [];
    if (peFlag) reasons.push(`PE ${pe} > 行业均值 ${industryPE} × 1.5`);
    if (profitFlag) reasons.push('净利润增速为负');
    return {
      triggered: true,
      ruleId: 'R026',
      message: `⚠️ 选股-基本面：${reasons.join('，')}，不符合心姐选股标准`,
      extraData: JSON.stringify({ pe, industryPE, profitGrowth })
    };
  }
  return { triggered: false };
}

// ==================== 三重滤网简化版（5/13 金死叉 + 55 日线定大势） ====================

/**
 * R027: 5/13 死叉 — MA5 下穿 MA13，只有卖点没有买点；同步处于 55 日线下方则升级为下跌中继
 * 来源：三重滤网简化版 | 避坑：横盘震荡时频繁金叉死叉，需结合量能/MACD 过滤
 */
function checkMa5Cross13Death(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 14) return { triggered: false };
  const idx = kLines.length - 1;
  const ma5 = calculateMA(kLines, 5);
  const ma13 = calculateMA(kLines, 13);
  // 最近 2 根内出现死叉且当前仍为死叉状态（容错扫描隔日补检）
  if (!crossedBelowWithin(ma5, ma13, idx, 2)) return { triggered: false };

  // 是否同时跌破 55 日线（下跌中继风险升级）
  let belowMa55 = false;
  let ma55 = 0;
  if (kLines.length >= 55) {
    ma55 = calculateMA(kLines, 55)[idx];
    belowMa55 = ma55 > 0 && kLines[idx].close < ma55;
  }

  const prefix = belowMa55 ? '🔴' : '⚠️';
  return {
    triggered: true,
    ruleId: 'R027',
    message: `${prefix} 5日死叉13日：MA5 ${ma5[idx].toFixed(2)} < MA13 ${ma13[idx].toFixed(2)}，只有卖点没有买点${belowMa55 ? `（同步跌破55日线 ${ma55.toFixed(2)}，下跌中继风险，规避）` : ''}`,
    extraData: JSON.stringify({ ma5: ma5[idx], ma13: ma13[idx], belowMa55 }),
    barIndex: idx
  };
}

/**
 * R028: 5/13 金叉 — MA5 上穿 MA13，可考虑买点；放量 + 站上 55 日线才视为有效信号，
 *        缩量则提示横盘震荡中的假信号（需 MACD 确认）
 * 来源：三重滤网简化版
 */
function checkMa5Cross13Golden(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 14) return { triggered: false };
  const idx = kLines.length - 1;
  const ma5 = calculateMA(kLines, 5);
  const ma13 = calculateMA(kLines, 13);
  if (!crossedAboveWithin(ma5, ma13, idx, 2)) return { triggered: false };

  const today = kLines[idx];
  const avg5 = calculateAvgVolume(kLines.slice(0, -1), 5);
  const volConfirmed = avg5 > 0 && today.volume > avg5 * 1.2;

  // 是否站上 55 日线（多头区域更可靠）
  let aboveMa55 = true; // 数据不足时不以此降级
  if (kLines.length >= 55) {
    const ma55 = calculateMA(kLines, 55)[idx];
    aboveMa55 = ma55 > 0 && today.close > ma55;
  }

  let message: string;
  if (volConfirmed && aboveMa55) {
    message = `🟢 5日金叉13日：MA5 ${ma5[idx].toFixed(2)} > MA13 ${ma13[idx].toFixed(2)}，放量确认 + 站上55日线，可考虑买点`;
  } else if (volConfirmed) {
    message = `🟢 5日金叉13日：MA5 ${ma5[idx].toFixed(2)} > MA13 ${ma13[idx].toFixed(2)}，放量确认，可考虑买点（尚未站上55日线，谨慎）`;
  } else {
    message = `ℹ️ 5日金叉13日：MA5 ${ma5[idx].toFixed(2)} > MA13 ${ma13[idx].toFixed(2)}，但缩量，横盘震荡中可能是假信号，需MACD确认`;
  }
  return {
    triggered: true,
    ruleId: 'R028',
    message,
    extraData: JSON.stringify({ ma5: ma5[idx], ma13: ma13[idx], volConfirmed, aboveMa55 }),
    barIndex: idx
  };
}

/**
 * R029: 跌破 55 日线 — 收盘下穿 MA55，进入非多头区域，55 日线定大势，不是当下好的选择
 * 来源：三重滤网简化版
 */
function checkBreakMa55(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 56) return { triggered: false };
  const idx = kLines.length - 1;
  const ma55 = calculateMA(kLines, 55);
  if (!priceCrossedBelowWithin(kLines, ma55, idx, 2)) return { triggered: false };

  const today = kLines[idx];
  return {
    triggered: true,
    ruleId: 'R029',
    message: `⚠️ 跌破55日线：收盘 ${today.close} < MA55 ${ma55[idx].toFixed(2)}，进入非多头区域，不是当下好的选择（55日线定大势）`,
    extraData: JSON.stringify({ close: today.close, ma55: ma55[idx] }),
    barIndex: idx
  };
}

// ==================== 预警规则配置 ====================

export const ALERT_RULES: AlertRule[] = [
  {
    id: 'R001',
    name: '巨量预警',
    description: '当日成交量 > 近5日均量 × 1.20',
    category: 'VOLUME' as any,
    level: 'WARNING' as any,
    suggestion: '放量需关注，结合位置判断',
    isEnabled: true,
    thresholdValue: 1.20
  },
  {
    id: 'R002',
    name: '巨量见顶',
    description: '成交量达到近一年最大值或超过近5日最高量×1.2',
    category: 'VOLUME' as any,
    level: 'CRITICAL' as any,
    suggestion: '历史天量，大概率见顶，减仓',
    isEnabled: true
  },
  {
    id: 'R003',
    name: '长上影线',
    description: '上影线>3%且急拉缓跌，放量时升级为CRITICAL',
    category: 'PATTERN' as any,
    level: 'WARNING' as any,
    suggestion: '高位长上影+放量=强卖出信号',
    isEnabled: true
  },
  {
    id: 'R004',
    name: '破五日线',
    description: '收盘价跌破MA5且放量',
    category: 'MOVING_AVG' as any,
    level: 'CRITICAL' as any,
    suggestion: '短期趋势转弱，减仓观望',
    isEnabled: true
  },
  {
    id: 'R005',
    name: '破趋势线',
    description: '收盘连续跌破趋势支撑且放量，同步破MA60升级为强信号',
    category: 'MOVING_AVG' as any,
    level: 'CRITICAL' as any,
    suggestion: '趋势破位及时止盈，破MA60则清仓观望',
    isEnabled: true
  },
  {
    id: 'R006',
    name: '超大阳线',
    description: '单日涨幅>5.5%',
    category: 'PRICE' as any,
    level: 'WARNING' as any,
    suggestion: '考虑分批止盈',
    isEnabled: true
  },
  {
    id: 'R007',
    name: '连阳预警',
    description: '连续3天以上大涨(>3%)',
    category: 'PATTERN' as any,
    level: 'WARNING' as any,
    suggestion: '多头衰竭，逐步止盈',
    isEnabled: true
  },
  {
    id: 'R008',
    name: '妇联定律',
    description: '工业富联大涨>8%预警',
    category: 'SENTIMENT' as any,
    level: 'CRITICAL' as any,
    suggestion: '警惕科技板块大分歧，减仓',
    isEnabled: true
  },
  {
    id: 'R009',
    name: '第二波见顶',
    description: '近期成交量接近第一波高潮',
    category: 'VOLUME' as any,
    level: 'CRITICAL' as any,
    suggestion: '二波高潮可能见顶，止盈',
    isEnabled: true
  },
  {
    id: 'R010',
    name: '急跌预警',
    description: '单日跌幅<-7%',
    category: 'PRICE' as any,
    level: 'CRITICAL' as any,
    suggestion: '暴跌止损',
    isEnabled: true
  },
  {
    id: 'R011',
    name: '反包入场',
    description: '回调后放量反包突破',
    category: 'OPPORTUNITY' as any,
    level: 'INFO' as any,
    suggestion: '企稳反包，考虑入场',
    isEnabled: true
  },
  {
    id: 'R012',
    name: '箱体吸筹',
    description: '长时间横盘后放量小阳',
    category: 'OPPORTUNITY' as any,
    level: 'INFO' as any,
    suggestion: '箱体吸筹完成，关注',
    isEnabled: true
  },
  {
    id: 'R013',
    name: '缩量破位',
    description: '缩量跌破MA5，连续两日破位才确认',
    category: 'MOVING_AVG' as any,
    level: 'WARNING' as any,
    suggestion: '缩量可能是健康调整（洗盘），趋势同步破位才减仓',
    isEnabled: true
  },
  {
    id: 'R014',
    name: '对子顶',
    description: '连续两天高点/收盘接近+上影+放量',
    category: 'PATTERN' as any,
    level: 'CRITICAL' as any,
    suggestion: '典型顶部形态，坚决清仓',
    isEnabled: true
  },
  {
    id: 'R015',
    name: '止跌企稳',
    description: '抛压释放(>10%)+新低区锤子线(下影≥实体×2+上影<1%)或十字星',
    category: 'OPPORTUNITY' as any,
    level: 'INFO' as any,
    suggestion: '经典锤子线企稳信号，结合量能确认低吸',
    isEnabled: true
  },
  {
    id: 'R016',
    name: '黄金位反弹',
    description: '回调至黄金位(38.2%-61.8%)放量反弹',
    category: 'OPPORTUNITY' as any,
    level: 'INFO' as any,
    suggestion: '黄金支撑反弹，入场机会',
    isEnabled: true
  },
  {
    id: 'R017',
    name: '横盘滞涨',
    description: '5日内振幅<5%且累计涨幅<2%',
    category: 'PATTERN' as any,
    level: 'WARNING' as any,
    suggestion: '横盘滞涨，防止利润回吐',
    isEnabled: true
  },
  // ==================== 心姐 1.0 版新增规则 ====================
  {
    id: 'R018',
    name: 'RSI超卖',
    description: 'RSI(6) < 20，进入超卖区（ART026，A级可信度）',
    category: 'RSI' as any,
    level: 'INFO' as any,
    suggestion: '超卖区适合逢低布局，结合趋势确认',
    isEnabled: true
  },
  {
    id: 'R019',
    name: 'RSI底背离',
    description: '价格创近期新低但RSI未同步新低（ART026，A级可信度）',
    category: 'RSI' as any,
    level: 'INFO' as any,
    suggestion: '底背离是较可靠的买入信号，确认后入场',
    isEnabled: true
  },
  {
    id: 'R020',
    name: '放量离场',
    description: '量比>2倍均值且价格破位（收<MA5或破趋势线）（ART141，A级可信度）',
    category: 'VOLUME' as any,
    level: 'CRITICAL' as any,
    suggestion: '放量破位=强势离场信号，果断减仓',
    isEnabled: true
  },
  {
    id: 'R021',
    name: '缩量阴线健康',
    description: '阴线但缩量且趋势未破(收>MA10)（ART132，B级可信度）',
    category: 'VOLUME' as any,
    level: 'INFO' as any,
    suggestion: '缩量回调可能是洗盘，不急于止损',
    isEnabled: true
  },
  {
    id: 'R022',
    name: '大阳调整健康',
    description: '近10日>3%大阳线≤2根且近3日横盘（ART058，B级可信度）',
    category: 'PATTERN' as any,
    level: 'INFO' as any,
    suggestion: '大阳线后调整充分，关注再次启动',
    isEnabled: true
  },
  {
    id: 'R023',
    name: '箱体突破',
    description: '40日振幅<20%+突破上沿>3%+放量确认（ART061，D级实验性）',
    category: 'PATTERN' as any,
    level: 'INFO' as any,
    suggestion: '箱体突破是趋势启动信号，可试探性建仓',
    isEnabled: true
  },
  {
    id: 'R024',
    name: '选股-价格位',
    description: '当前价>120日最低价×2.5，不符合心姐选股标准（ART009，A级可信度）',
    category: 'FUNDAMENTAL' as any,
    level: 'WARNING' as any,
    suggestion: '价格过高，不符合逢低布局原则',
    isEnabled: true
  },
  {
    id: 'R025',
    name: '选股-资金面',
    description: '两周回撤>50%或多根大阴线，抛压过大（ART009，A级可信度）',
    category: 'FUNDAMENTAL' as any,
    level: 'WARNING' as any,
    suggestion: '抛压过大，等待充分释放后再考虑',
    isEnabled: true
  },
  {
    id: 'R026',
    name: '选股-基本面',
    description: 'PE>行业×1.5或净利润增速<0（ART009，A级可信度）',
    category: 'FUNDAMENTAL' as any,
    level: 'WARNING' as any,
    suggestion: '基本面不达标，不符合心姐业绩支撑原则',
    isEnabled: true
  },
  // ==================== 三重滤网简化版（5/13 金死叉 + 55 日线定大势） ====================
  {
    id: 'R027',
    name: '5/13死叉',
    description: 'MA5下穿MA13只有卖点没有买点；同步跌破55日线则下跌中继（三重滤网简化版）',
    category: 'MOVING_AVG' as any,
    level: 'WARNING' as any,
    suggestion: '死叉区域不抢反弹，仅考虑卖点；跌破55日线则规避',
    isEnabled: true
  },
  {
    id: 'R028',
    name: '5/13金叉',
    description: 'MA5上穿MA13，放量+站上55日线才视为有效买点；缩量可能是假信号（三重滤网简化版）',
    category: 'OPPORTUNITY' as any,
    level: 'INFO' as any,
    suggestion: '金叉可考虑买点，缩量或未站上55日线时结合MACD确认',
    isEnabled: true
  },
  {
    id: 'R029',
    name: '跌破55日线',
    description: '收盘跌破MA55进入非多头区域，55日线定大势（三重滤网简化版）',
    category: 'MOVING_AVG' as any,
    level: 'WARNING' as any,
    suggestion: '非多头区域不轻易做多，等待重新站上55日线',
    isEnabled: true
  }
];

/**
 * 检查所有启用的规则
 */
export function checkAllRules(
  kLines: KLineData[],
  quote: RealtimeQuote | null,
  enabledRules: AlertRule[] = ALERT_RULES.filter(r => r.isEnabled)
): RuleCheckResult[] {
  const results: RuleCheckResult[] = [];

  for (const rule of enabledRules) {
    let result: RuleCheckResult;
    switch (rule.id) {
      case 'R001': result = checkVolumeRule(kLines, quote, rule); break;
      case 'R002': result = checkVolumePeak(kLines, quote, rule); break;
      case 'R003': result = checkLongUpperShadow(kLines, quote, rule); break;
      case 'R004': result = checkBreakMa5(kLines, quote, rule); break;
      case 'R005': result = checkBreakTrendLine(kLines, quote, rule); break;
      case 'R006': result = checkBigYangLine(kLines, quote, rule); break;
      case 'R007': result = checkConsecutiveYang(kLines, quote, rule); break;
      case 'R008': result = checkFuliLaw(kLines, quote, rule); break;
      case 'R009': result = checkSecondWaveVolume(kLines, quote, rule); break;
      case 'R010': result = checkSuddenDrop(kLines, quote, rule); break;
      case 'R011': result = checkReboundEntry(kLines, quote, rule); break;
      case 'R012': result = checkBoxAccumulation(kLines, quote, rule); break;
      case 'R013': result = checkLowVolBreak(kLines, quote, rule); break;
      case 'R014': result = checkDoubleTop(kLines, quote, rule); break;
      case 'R015': result = checkBottomStabilize(kLines, quote, rule); break;
      case 'R016': result = checkGoldenRebound(kLines, quote, rule); break;
      case 'R017': result = checkSideways(kLines, quote, rule); break;
      case 'R018': result = checkRSIOversold(kLines, quote, rule); break;
      case 'R019': result = checkRSIDivergence(kLines, quote, rule); break;
      case 'R020': result = checkVolumeSurgeExit(kLines, quote, rule); break;
      case 'R021': result = checkHealthyPullback(kLines, quote, rule); break;
      case 'R022': result = checkBigYangAdjustment(kLines, quote, rule); break;
      case 'R023': result = checkBoxBreakout(kLines, quote, rule); break;
      case 'R024': result = checkPricePosition(kLines, quote, rule); break;
      case 'R025': result = checkCapitalStatus(kLines, quote, rule); break;
      case 'R026': result = checkFundamentalFilter(kLines, quote, rule); break;
      case 'R027': result = checkMa5Cross13Death(kLines, quote, rule); break;
      case 'R028': result = checkMa5Cross13Golden(kLines, quote, rule); break;
      case 'R029': result = checkBreakMa55(kLines, quote, rule); break;
      default: result = { triggered: false };
    }

    if (result.triggered) {
      results.push(result);
    }
  }

  return results;
}

/**
 * 规则可信度 → AI Prompt 分级注入
 * 将触发的规则按 PDF 可信度分为三组，AI 可以据此判断信号强度
 */
const RULE_RELIABILITY: Record<string, { level: string; role: string }> = {
  R001: { level: 'A', role: '通用' },
  R002: { level: 'A', role: '通用' },
  R003: { level: 'A', role: '通用' },
  R004: { level: 'A', role: '通用' },
  R005: { level: 'A', role: '通用' },
  R006: { level: 'A', role: '通用' },
  R007: { level: 'A', role: '通用' },
  R008: { level: 'A', role: '通用' },
  R009: { level: 'A', role: '通用' },
  R010: { level: 'A', role: '通用' },
  R011: { level: 'B', role: '技术分析师' },
  R012: { level: 'B', role: '技术分析师' },
  R013: { level: 'A', role: '通用' },
  R014: { level: 'A', role: '通用' },
  R015: { level: 'A', role: '通用' },
  R016: { level: 'B', role: '技术分析师' },
  R017: { level: 'B', role: '通用' },
  R018: { level: 'A', role: '技术分析师' },
  R019: { level: 'A', role: '技术分析师' },
  R020: { level: 'A', role: '风控专家' },
  R021: { level: 'B', role: '技术分析师' },
  R022: { level: 'B', role: '技术分析师' },
  R023: { level: 'D', role: '技术分析师' },
  R024: { level: 'A', role: '心姐' },
  R025: { level: 'A', role: '心姐' },
  R026: { level: 'A', role: '心姐' },
  R027: { level: 'B', role: '技术分析师' },
  R028: { level: 'B', role: '技术分析师' },
  R029: { level: 'B', role: '技术分析师' },
};

/**
 * 以分级格式返回触发规则描述，用于注入 AI prompt
 * 强信号(A级) → AI 应高度重视
 * 参考信号(B级) → AI 可结合其他因素判断
 * 实验信号(D级) → AI 应谨慎引用
 */
export function formatTriggeredRulesForAI(results: RuleCheckResult[]): string {
  if (!results || results.length === 0) return '无';

  const strong: string[] = [];
  const reference: string[] = [];
  const experimental: string[] = [];

  for (const r of results) {
    if (!r.ruleId) continue;
    const info = RULE_RELIABILITY[r.ruleId];
    const tag = info ? `[${info.level}级·${info.role}]` : '';
    const text = `${r.message} ${tag}`;

    if (info?.level === 'D') {
      experimental.push(text);
    } else if (info?.level === 'B') {
      reference.push(text);
    } else {
      strong.push(text);
    }
  }

  let output = '';
  if (strong.length > 0) output += `🔴 强信号（需高度重视）：\n${strong.map(s => `  - ${s}`).join('\n')}\n`;
  if (reference.length > 0) output += `🟡 参考信号（结合其他因素判断）：\n${reference.map(s => `  - ${s}`).join('\n')}\n`;
  if (experimental.length > 0) output += `⚪ 实验信号（谨慎引用）：\n${experimental.map(s => `  - ${s}`).join('\n')}`;

  return output || '无';
}