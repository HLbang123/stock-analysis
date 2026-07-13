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
 * 辅助函数：计算上影线百分比
 */
function calculateUpperShadowPercent(k: KLineData): number {
  const bodyTop = Math.max(k.open, k.close);
  const bodyBottom = Math.min(k.open, k.close);
  const range = k.high - k.low;
  if (range === 0) return 0;
  return ((k.high - bodyTop) / range) * 100;
}

/**
 * 辅助函数：计算下影线百分比
 */
function calculateLowerShadowPercent(k: KLineData): number {
  const bodyTop = Math.max(k.open, k.close);
  const bodyBottom = Math.min(k.open, k.close);
  const range = k.high - k.low;
  if (range === 0) return 0;
  return ((bodyBottom - k.low) / range) * 100;
}

// ==================== 规则检查器 ====================

/**
 * R001: 巨量预警 - 当日成交量 > 近5日均量 × 1.25
 */
function checkVolumeRule(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 6) return { triggered: false };
  const idx = kLines.length - 1;
  const today = kLines[idx];
  const avg5 = calculateAvgVolume(kLines.slice(0, -1), 5);
  const threshold = rule.thresholdValue ?? 1.25;

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
 * R003: 长上影线 - 上影线 > 3% 且 急拉缓跌
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
    return {
      triggered: true,
      ruleId: 'R003',
      message: `⚠️ 冲高回落：上影线 ${upperShadow.toFixed(2)}%，涨幅 ${todayChange.toFixed(2)}%`,
      extraData: JSON.stringify({ shadow: upperShadow }),
      barIndex: idx
    };
  }
  return { triggered: false };
}

/**
 * R004: 破五日线
 */
function checkBreakMa5(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 6) return { triggered: false };
  const idx = kLines.length - 1;
  const today = kLines[idx];
  const ma5 = calculateMA(kLines, 5)[idx];
  const prev1 = kLines[idx - 1];

  if (today.close < ma5 && today.volume > prev1.volume * 1.1) {
    return {
      triggered: true,
      ruleId: 'R004',
      message: `🔴 破五日线：收盘 ${today.close}，MA5 ${ma5.toFixed(2)}，放量跌破`,
      extraData: JSON.stringify({ close: today.close }),
      barIndex: idx
    };
  }
  return { triggered: false };
}

/**
 * R005: 破趋势线
 */
function checkBreakTrendLine(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 15) return { triggered: false };
  const idx = kLines.length - 1;
  const today = kLines[idx];
  const recent10 = kLines.slice(-10);
  const trendLine = recent10.reduce((sum, k) => sum + k.low, 0) / 10;
  const prev1 = kLines[idx - 1];

  if (today.close < trendLine && prev1.close < trendLine && today.volume > prev1.volume * 1.05) {
    return {
      triggered: true,
      ruleId: 'R005',
      message: `🔴 破趋势线：收盘 ${today.close}，趋势支撑 ${trendLine.toFixed(2)}`,
      extraData: JSON.stringify({ close: today.close }),
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
 * R013: 缩量破位
 */
function checkLowVolBreak(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 6) return { triggered: false };
  const idx = kLines.length - 1;

  const today = kLines[idx];
  const prev1 = kLines[idx - 1];
  const ma5 = calculateMA(kLines, 5)[idx];

  if (today.close < ma5 && today.volume < prev1.volume * 0.9) {
    return {
      triggered: true,
      ruleId: 'R013',
      message: `🟡 缩量破位：收盘 ${today.close} < MA5 ${ma5.toFixed(2)}，减仓一半`,
      extraData: '{}',
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
 * R015: 止跌企稳
 */
function checkBottomStabilize(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 15) return { triggered: false };
  const idx = kLines.length - 1;

  const today = kLines[idx];
  const min15Low = Math.min(...kLines.slice(-15).map(k => k.low));

  if (today.low > min15Low * 1.005) return { triggered: false };

  const lowerShadow = calculateLowerShadowPercent(today);
  const isDoji = Math.abs(today.close - today.open) / today.open < 0.005;

  let sig = '';
  if (lowerShadow > 2.0) sig = `长下影 ${lowerShadow.toFixed(1)}%`;
  else if (isDoji) sig = '十字星';

  if (sig) {
    return {
      triggered: true,
      ruleId: 'R015',
      message: `🟢 止跌企稳：新低区域出现${sig}，关注低吸`,
      extraData: '{}',
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

// ==================== 预警规则配置 ====================

export const ALERT_RULES: AlertRule[] = [
  {
    id: 'R001',
    name: '巨量预警',
    description: '当日成交量 > 近5日均量 × 1.25',
    category: 'VOLUME' as any,
    level: 'WARNING' as any,
    suggestion: '放量需关注，结合位置判断',
    isEnabled: true,
    thresholdValue: 1.25
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
    description: '上影线>3%且急拉缓跌',
    category: 'PATTERN' as any,
    level: 'WARNING' as any,
    suggestion: '高位长上影是卖出信号',
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
    description: '收盘价连续跌破趋势支撑且放量',
    category: 'MOVING_AVG' as any,
    level: 'CRITICAL' as any,
    suggestion: '趋势破位，及时止盈',
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
    description: '缩量跌破MA5',
    category: 'MOVING_AVG' as any,
    level: 'WARNING' as any,
    suggestion: '减仓一半观察',
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
    description: '新低区出现长下影或十字星',
    category: 'OPPORTUNITY' as any,
    level: 'INFO' as any,
    suggestion: '企稳信号，低吸机会',
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
      default: result = { triggered: false };
    }

    if (result.triggered) {
      results.push(result);
    }
  }

  return results;
}