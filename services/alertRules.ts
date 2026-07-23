import { KLineData, RealtimeQuote, AlertRule, RuleCheckResult } from '@/types';
import { calculateMA as calcMAValues, calcRSISeries } from '@/lib/indicators';
import { splitKLines } from '@/lib/stock-helpers';

/**
 * 移动平均线序列（单一事实源：复用 lib/indicators，避免与详情页/AI页两套 MA 分叉）。
 * lib 版以 number[] 入参、数据不足处为 NaN；此处包一层 KLineData[]→close[]。
 * 调用方均有 length>=5 守卫且只读近端 idx，早期 NaN 不影响行为。
 */
function calculateMA(kLines: KLineData[], period: number): number[] {
  return calcMAValues(kLines.map(k => k.close), period);
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
 * RSI（单一事实源：复用 lib/indicators 的 Wilder RSI 序列，与详情页/AI页同源同值）。
 * 合成盘中 bar 的剥离由 splitKLines 在数据边界统一处理——本函数不再手写
 * date===today 判断。旧实现用"最后 period 根简单平均"(SMA-RSI)，盘中一根 -3%
 * 合成 bar 直接占 1/6 无历史稀释，能把 RSI6 从 32 砸到 19.7；改 Wilder 全历史
 * 平滑后与同花顺对齐。
 */
function calculateRSI(kLines: KLineData[], period: number = 6): number {
  const { completedBars } = splitKLines(kLines);
  const arr = calcRSISeries(completedBars.map(k => k.close), period);
  const v = arr[arr.length - 1];
  return isNaN(v) ? 50 : v;
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

/**
 * 价格上穿某均线是否在最近 within 根内发生，且当前仍处于价格>均线状态。
 */
function priceCrossedAboveWithin(kLines: KLineData[], ma: number[], idx: number, within: number): boolean {
  if (kLines[idx].close <= ma[idx]) return false;
  for (let i = idx; i > idx - within && i >= 1; i--) {
    if (kLines[i - 1].close <= ma[i - 1] && kLines[i].close > ma[i]) return true;
  }
  return false;
}

// ==================== 规则检查器（16条合并规则） ====================
//
// 设计原则：一只票破位只出一条「趋势破位」，见顶只出一条「见顶形态」。
// 合并后的规则内部按严重度择优返回最强信号，避免 4-6 条冗余预警。

/**
 * R01: 巨量异动 — 合并原 R001(巨量预警) + R002(巨量见顶)
 * 量≥年最大×0.95 或 >5日最高×1.2 → 见顶(🔴)；否则 >5日均量×1.20 → 异动(⚠️)
 */
function checkVolumeAbnormal(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 10) return { triggered: false };
  const idx = kLines.length - 1;
  const today = kLines[idx];
  const avg5 = calculateAvgVolume(kLines.slice(0, -1), 5);
  const threshold = rule.thresholdValue ?? 1.20;
  const maxYear = Math.max(...kLines.map(k => k.volume));
  const max5 = calculateMaxVolume(kLines.slice(0, -1), 5);

  const isPeak = today.volume >= maxYear * 0.95 || (max5 > 0 && today.volume > max5 * 1.2);
  if (isPeak) {
    return {
      triggered: true,
      ruleId: 'R01',
      message: `🔴 巨量见顶：成交量 ${today.volume}，5日最高 ${max5}，年最高 ${maxYear}`,
      extraData: JSON.stringify({ todayVol: today.volume, isPeak: true }),
      barIndex: idx
    };
  }

  if (avg5 > 0 && today.volume > avg5 * threshold) {
    return {
      triggered: true,
      ruleId: 'R01',
      message: `⚠️ 巨量异动：成交量 ${today.volume}，近5日均量 ${Math.round(avg5)}，放量 ${Math.round(today.volume / avg5 * 100 - 100)}%`,
      extraData: JSON.stringify({ todayVol: today.volume, isPeak: false }),
      barIndex: idx
    };
  }
  return { triggered: false };
}

/**
 * R02: 见顶形态 — 合并原 R003(长上影线) + R014(对子顶)
 * 对子顶(高点/收盘接近+上影+放量)优先；否则冲高回落(上影>3%+急拉缓跌)，放量升🔴
 */
function checkTopPattern(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 5) return { triggered: false };
  const idx = kLines.length - 1;
  const today = kLines[idx];
  const prev1 = kLines[idx - 1];
  const upperShadow = calculateUpperShadowPercent(today);
  const avg5 = calculateAvgVolume(kLines.slice(0, -1), 5);
  const isHighVol = today.volume > avg5 * 1.2;

  // 对子顶（更强）
  const highMatch = Math.abs(today.high - prev1.high) / prev1.high < 0.001;
  const closeMatch = Math.abs(today.close - prev1.close) / prev1.close < 0.001;
  if ((highMatch || closeMatch) && upperShadow > 2.5 && isHighVol) {
    return {
      triggered: true,
      ruleId: 'R02',
      message: `🔴 对子顶：高点/收盘接近+上影 ${upperShadow.toFixed(1)}% + 放量！`,
      extraData: JSON.stringify({ shadow: upperShadow, type: 'doubleTop' }),
      barIndex: idx
    };
  }

  // 长上影线（冲高回落）
  if (kLines.length >= 4) {
    const prev2 = kLines[idx - 2];
    const prevChange = calculateChangePercent(prev1.close, prev2.close);
    const todayChange = calculateChangePercent(today.close, prev1.close);
    if (upperShadow > 3.0 && prevChange > 3 && todayChange < prevChange - 2) {
      const prefix = isHighVol ? '🔴' : '⚠️';
      return {
        triggered: true,
        ruleId: 'R02',
        message: `${prefix} 冲高回落${isHighVol ? '（放量见顶）' : ''}：上影 ${upperShadow.toFixed(2)}%，涨幅 ${todayChange.toFixed(2)}%`,
        extraData: JSON.stringify({ shadow: upperShadow, isHighVol, type: 'upperShadow' }),
        barIndex: idx
      };
    }
  }
  return { triggered: false };
}

/**
 * R03: 趋势破位 — 合并原 R004(破五日线) + R005(破趋势线) + R013(缩量破位) + R020(放量离场)
 * 内部按严重度择优返回一条：破趋势线+破MA60 > 放量离场/破五日线(量比>2) > 破趋势线/破五日线 > 缩量破位 > 缩量破MA5
 */
function checkTrendBreak(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 6) return { triggered: false };
  const idx = kLines.length - 1;
  const today = kLines[idx];
  const prev1 = kLines[idx - 1];
  const ma5Arr = calculateMA(kLines, 5);
  const ma5 = ma5Arr[idx];
  const avg5 = calculateAvgVolume(kLines.slice(0, -1), 5);
  const volRatio = avg5 > 0 ? today.volume / avg5 : 1;

  // [severity, message, extra]
  const candidates: Array<[number, string, string]> = [];

  // 破趋势线（10日低点均线）+ 同步破MA60 → 最强
  if (kLines.length >= 60) {
    const trendLine = kLines.slice(-10).reduce((s, k) => s + k.low, 0) / 10;
    if (today.close < trendLine && prev1.close < trendLine && today.volume > prev1.volume * 1.05) {
      const ma60 = calculateMA(kLines, 60)[idx];
      const belowMA60 = ma60 > 0 && today.close < ma60;
      if (belowMA60) {
        candidates.push([4, `🔴🔴 趋势破位+破MA60：收盘 ${today.close}，趋势支撑 ${trendLine.toFixed(2)}，MA60 ${ma60.toFixed(2)}——牛熊分界已破，观望！`, JSON.stringify({ close: today.close, belowMA60, ma60 })]);
      } else {
        candidates.push([2, `🔴 趋势破位：收盘 ${today.close}，趋势支撑 ${trendLine.toFixed(2)}，放量跌破`, JSON.stringify({ close: today.close, trendLine })]);
      }
    }
  }

  // 放量离场（量比>2 + 破位）
  if (volRatio >= 2.0) {
    const ma10Low = kLines.slice(-10).reduce((s, k) => s + k.low, 0) / 10;
    if (today.close < ma5 || today.close < ma10Low) {
      candidates.push([3, `🔴 放量离场：量比 ${volRatio.toFixed(1)}倍 + 价格破位（收${today.close}），果断离场！`, JSON.stringify({ volRatio, close: today.close })]);
    }
  }

  // 破五日线（放量）
  if (today.close < ma5 && today.volume > prev1.volume * 1.1) {
    const isCritical = volRatio > 2.0;
    candidates.push([isCritical ? 3 : 2, `${isCritical ? '🔴' : '⚠️'} 破五日线：收盘 ${today.close}，MA5 ${ma5.toFixed(2)}，放量跌破${isCritical ? '（量比>2，强烈离场信号！）' : ''}`, JSON.stringify({ close: today.close, volRatio })]);
  }

  // 缩量破位
  if (today.close < ma5 && today.volume < prev1.volume * 0.9) {
    const prevBelowMA5 = prev1.close < ma5Arr[idx - 1];
    if (prevBelowMA5) {
      candidates.push([1, `🟡 缩量破位（趋势确认）：连续两日收<MA5，缩量${today.close < prev1.close ? '阴跌' : ''}，减仓观望`, JSON.stringify({ trendBroken: true })]);
    } else {
      candidates.push([0, `ℹ️ 缩量破MA5：收 ${today.close} < MA5 ${ma5.toFixed(2)}，但缩量可能是健康调整，关注趋势是否同步破位`, JSON.stringify({ trendBroken: false })]);
    }
  }

  if (candidates.length === 0) return { triggered: false };
  candidates.sort((a, b) => b[0] - a[0]);
  const [, msg, extra] = candidates[0];
  return { triggered: true, ruleId: 'R03', message: msg, extraData: extra, barIndex: idx };
}

/**
 * R04: 5/13 死叉 — 原 R027。MA5 下穿 MA13，只有卖点没有买点；同步处于 55 日线下方则升级为下跌中继
 */
function checkMa5Cross13Death(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 14) return { triggered: false };
  const idx = kLines.length - 1;
  const ma5 = calculateMA(kLines, 5);
  const ma13 = calculateMA(kLines, 13);
  if (!crossedBelowWithin(ma5, ma13, idx, 2)) return { triggered: false };

  let belowMa55 = false;
  let ma55 = 0;
  if (kLines.length >= 55) {
    ma55 = calculateMA(kLines, 55)[idx];
    belowMa55 = ma55 > 0 && kLines[idx].close < ma55;
  }

  const prefix = belowMa55 ? '🔴' : '⚠️';
  return {
    triggered: true,
    ruleId: 'R04',
    message: `${prefix} 5日死叉13日：MA5 ${ma5[idx].toFixed(2)} < MA13 ${ma13[idx].toFixed(2)}，只有卖点没有买点${belowMa55 ? `（同步跌破55日线 ${ma55.toFixed(2)}，下跌中继风险，规避）` : ''}`,
    extraData: JSON.stringify({ ma5: ma5[idx], ma13: ma13[idx], belowMa55 }),
    barIndex: idx
  };
}

/**
 * R05: 跌破 55 日线 — 原 R029。收盘下穿 MA55，进入非多头区域，55 日线定大势
 */
function checkBreakMa55(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 56) return { triggered: false };
  const idx = kLines.length - 1;
  const ma55 = calculateMA(kLines, 55);
  if (!priceCrossedBelowWithin(kLines, ma55, idx, 2)) return { triggered: false };

  const today = kLines[idx];
  return {
    triggered: true,
    ruleId: 'R05',
    message: `⚠️ 跌破55日线：收盘 ${today.close} < MA55 ${ma55[idx].toFixed(2)}，进入非多头区域，不是当下好的选择（55日线定大势）`,
    extraData: JSON.stringify({ close: today.close, ma55: ma55[idx] }),
    barIndex: idx
  };
}

/**
 * R06: 急跌预警 — 原 R010。单日跌幅 < -7%
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
      ruleId: 'R06',
      message: `🔴 急跌预警：暴跌 ${change.toFixed(2)}%，先抛再说！`,
      extraData: JSON.stringify({ change }),
      barIndex: idx
    };
  }
  return { triggered: false };
}

/**
 * R07: 连阳过热 — 合并原 R006(超大阳线) + R007(连阳预警)
 * 三连阳 > 连2天大涨(3%-5.5%) > 超大阳线(>5.5%)，择优返回
 */
function checkOverheat(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 4) return { triggered: false };
  const idx = kLines.length - 1;
  const today = kLines[idx];
  const prev1 = kLines[idx - 1];
  const change = calculateChangePercent(today.close, prev1.close);

  if (idx >= 3) {
    const c3 = kLines[idx - 3];
    const c2 = kLines[idx - 2];
    const chg4to3 = calculateChangePercent(c3.close, kLines[idx - 4].close);
    const chg3to2 = calculateChangePercent(c2.close, c3.close);
    const chg2to1 = calculateChangePercent(today.close, c2.close);

    // 三连阳
    if (chg4to3 > 0 && chg3to2 > 0 && chg2to1 > 0) {
      return {
        triggered: true,
        ruleId: 'R07',
        message: `⚠️ 连阳过热：三连阳，连续3天上涨，考虑逐步止盈`,
        extraData: JSON.stringify({ consecutive: 3 }),
        barIndex: idx
      };
    }
    // 连2天大涨 3%-5.5%
    if (chg3to2 > 0 && chg2to1 > 0 && chg3to2 >= 3.0 && chg3to2 <= 5.5 && chg2to1 >= 3.0 && chg2to1 <= 5.5) {
      return {
        triggered: true,
        ruleId: 'R07',
        message: `⚠️ 连阳过热：连续大涨 ${chg3to2.toFixed(2)}%, ${chg2to1.toFixed(2)}%`,
        extraData: JSON.stringify({ chg2: chg3to2 }),
        barIndex: idx
      };
    }
  }

  // 超大阳线
  if (change > 5.5) {
    return {
      triggered: true,
      ruleId: 'R07',
      message: `⚠️ 连阳过热：超大阳线 涨幅 ${change.toFixed(2)}%，考虑止盈`,
      extraData: JSON.stringify({ change }),
      barIndex: idx
    };
  }
  return { triggered: false };
}

/**
 * R08: 妇联定律 — 原 R008。工业富联大涨>8% 警惕科技板块大分歧
 */
function checkFuliLaw(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (quote?.code !== 'sh601138') return { triggered: false };

  const change = quote.changePercent;
  if (change > 8.0) {
    return {
      triggered: true,
      ruleId: 'R08',
      message: `🔴 妇联定律：工业富联大涨 ${change.toFixed(2)}%，警惕科技板块大分歧！`,
      extraData: JSON.stringify({ change })
    };
  }
  return { triggered: false };
}

/**
 * R09: 第二波见顶 — 原 R009。近期成交量接近第一波高潮
 */
function checkSecondWaveVolume(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 60) return { triggered: false };
  const idx = kLines.length - 1;

  const firstWaveMax = Math.max(...kLines.slice(0, -1).map(k => k.volume));
  const recentMax = Math.max(...kLines.slice(-10).map(k => k.volume));

  if (firstWaveMax > 0 && recentMax >= firstWaveMax * 0.9) {
    return {
      triggered: true,
      ruleId: 'R09',
      message: `🔴 第二波见顶：近期量 ${recentMax} 接近第一波高潮 ${firstWaveMax}`,
      extraData: JSON.stringify({ recentMax }),
      barIndex: idx
    };
  }
  return { triggered: false };
}

/**
 * R10: 5/13 金叉 — 升级原 R028。MA5 上穿 MA13
 * 放量+站上55日线 → 强买(A级·WARNING)；否则 → 谨慎(B级·INFO)
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

  let aboveMa55 = true; // 数据不足时不以此降级
  if (kLines.length >= 55) {
    const ma55 = calculateMA(kLines, 55)[idx];
    aboveMa55 = ma55 > 0 && today.close > ma55;
  }

  let message: string;
  if (volConfirmed && aboveMa55) {
    message = `🟢 5日金叉13日（强买）：MA5 ${ma5[idx].toFixed(2)} > MA13 ${ma13[idx].toFixed(2)}，放量确认 + 站上55日线（A级·强买信号）`;
  } else if (volConfirmed) {
    message = `🟢 5日金叉13日：MA5 ${ma5[idx].toFixed(2)} > MA13 ${ma13[idx].toFixed(2)}，放量确认，但尚未站上55日线（B级·谨慎）`;
  } else {
    message = `ℹ️ 5日金叉13日：MA5 ${ma5[idx].toFixed(2)} > MA13 ${ma13[idx].toFixed(2)}，缩量，横盘震荡中可能是假信号，需MACD确认（B级）`;
  }
  return {
    triggered: true,
    ruleId: 'R10',
    message,
    extraData: JSON.stringify({ ma5: ma5[idx], ma13: ma13[idx], volConfirmed, aboveMa55 }),
    barIndex: idx
  };
}

/**
 * R11: 止跌企稳 — 原 R015。抛压释放(>10%) + 新低区域锤子线/十字星
 */
function checkBottomStabilize(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 15) return { triggered: false };
  const idx = kLines.length - 1;

  const today = kLines[idx];
  const min15Low = Math.min(...kLines.slice(-15).map(k => k.low));
  if (today.low > min15Low * 1.005) return { triggered: false };

  const prev15High = Math.max(...kLines.slice(-15, -1).map(k => k.high));
  const prev15Min = Math.min(...kLines.slice(-15, -1).map(k => k.low));
  const dropRange = (prev15High - prev15Min) / prev15High;
  if (dropRange < 0.10) return { triggered: false };

  const lowerShadowPct = calculateLowerShadowPercent(today);
  const upperShadowPct = calculateUpperShadowPercent(today);
  const body = Math.abs(today.close - today.open);
  const lowerShadowAbs = Math.min(today.open, today.close) - today.low;
  const isDoji = body / today.open < 0.005;

  const isHammer = body > 0 && lowerShadowAbs >= body * 2 && lowerShadowPct > 2.0 && upperShadowPct < 1.0;

  let sig = '';
  if (isHammer) sig = `锤子线（下影${lowerShadowPct.toFixed(1)}%，实体${(body / today.open * 100).toFixed(1)}%）`;
  else if (isDoji) sig = '十字星';

  if (sig) {
    return {
      triggered: true,
      ruleId: 'R11',
      message: `🟢 止跌企稳：抛压已释放 ${(dropRange * 100).toFixed(0)}%，新低区域出现${sig}，关注低吸`,
      extraData: JSON.stringify({ dropRange, lowerShadowPct, isHammer }),
      barIndex: idx
    };
  }
  return { triggered: false };
}

/**
 * R12: RSI 底部 — 合并原 R018(RSI超卖) + R019(RSI底背离)
 * 底背离(价格新低+RSI未新低)优先；否则 RSI(6)<20 超卖
 */
function checkRsiBottom(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 15) return { triggered: false };
  const idx = kLines.length - 1;

  // 底背离（更强）
  const recent5 = kLines.slice(-5);
  const recent5Min = Math.min(...recent5.map(k => k.low));
  const prev15Min = Math.min(...kLines.slice(-20, -5).map(k => k.low));
  const isPriceNewLow = recent5Min < prev15Min * 0.98;

  if (isPriceNewLow) {
    const rsiNow = calculateRSI(kLines.slice(0, idx + 1), 6);
    const rsiPrev = calculateRSI(kLines.slice(0, idx - 4), 6);
    if (rsiNow > rsiPrev * 1.05) {
      return {
        triggered: true,
        ruleId: 'R12',
        message: `🟢 RSI底背离：价格创近期新低，但RSI(6)=${rsiNow.toFixed(1)} 未同步新低（前值${rsiPrev.toFixed(1)}），买入信号`,
        extraData: JSON.stringify({ rsiNow, rsiPrev, divergence: true }),
        barIndex: idx
      };
    }
  }

  // RSI超卖
  if (kLines.length >= 10) {
    const rsi6 = calculateRSI(kLines, 6);
    if (rsi6 < 20) {
      return {
        triggered: true,
        ruleId: 'R12',
        message: `🟢 RSI超卖：RSI(6)=${rsi6.toFixed(1)} < 20，进入超卖区，适合逢低布局`,
        extraData: JSON.stringify({ rsi6, divergence: false }),
        barIndex: idx
      };
    }
  }
  return { triggered: false };
}

/**
 * R13: 反包入场 — 原 R011。回调后放量反包突破
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
      ruleId: 'R13',
      message: `🟢 反包入场：大涨 ${change.toFixed(2)}%，W型/C浪企稳反包`,
      extraData: JSON.stringify({ change }),
      barIndex: idx
    };
  }
  return { triggered: false };
}

/**
 * R14: 黄金位反弹 — 原 R016。回调至黄金位(38.2%-61.8%)放量反弹
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
      ruleId: 'R14',
      message: `🟢 黄金位反弹：回调至 ${(ratio * 100).toFixed(0)}% + 放量阳线 ${change.toFixed(1)}%`,
      extraData: JSON.stringify({ ratio, change }),
      barIndex: idx
    };
  }
  return { triggered: false };
}

/**
 * R15: 箱体信号 — 合并原 R012(箱体吸筹) + R023(箱体突破)
 * 突破(40日箱体上沿>3%+放量)优先；否则 吸筹(60日箱体+放量小阳)
 */
function checkBoxSignal(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 42) return { triggered: false };
  const idx = kLines.length - 1;
  const today = kLines[idx];
  const prev1 = kLines[idx - 1];
  const avgVol20 = calculateAvgVolume(kLines.slice(0, -1), 20);

  // 箱体突破
  const { high: boxHigh40, range: range40 } = getBoxRange(kLines.slice(0, -1), 40);
  if (range40 <= 0.20) {
    const breakoutPct = (today.close - boxHigh40) / boxHigh40 * 100;
    if (breakoutPct >= 3.0 && avgVol20 > 0 && today.volume >= avgVol20 * 1.2) {
      return {
        triggered: true,
        ruleId: 'R15',
        message: `🟢 箱体突破：40日箱体上沿${boxHigh40.toFixed(2)}，突破${breakoutPct.toFixed(1)}% + 放量确认`,
        extraData: JSON.stringify({ boxHigh: boxHigh40, breakoutPct, type: 'breakout' }),
        barIndex: idx
      };
    }
  }

  // 箱体吸筹
  if (kLines.length >= 60) {
    const recent60 = kLines.slice(-60);
    const boxHigh = Math.max(...recent60.map(k => k.high));
    const boxLow = Math.min(...recent60.map(k => k.low));
    const boxRange = (boxHigh - boxLow) / boxLow;
    if (boxRange <= 0.20) {
      const change = calculateChangePercent(today.close, prev1.close);
      if (change >= 1.0 && change <= 4.0 && avgVol20 > 0 && today.volume > avgVol20 * 1.3) {
        return {
          triggered: true,
          ruleId: 'R15',
          message: `🟢 箱体吸筹：放量小阳线 ${change.toFixed(2)}%，关注标的`,
          extraData: JSON.stringify({ change, type: 'accumulate' }),
          barIndex: idx
        };
      }
    }
  }
  return { triggered: false };
}

/**
 * R16: 均线多头排列（新增）— MA5>MA13>MA55 且股价站上MA55，且多头排列刚刚形成
 * 仅在近2根内 MA5上穿MA13 或 价格上穿MA55 时触发，避免每日重复
 */
function checkMaBullAlignment(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 55) return { triggered: false };
  const idx = kLines.length - 1;
  const ma5 = calculateMA(kLines, 5);
  const ma13 = calculateMA(kLines, 13);
  const ma55 = calculateMA(kLines, 55);
  const today = kLines[idx];

  if (!(ma5[idx] > ma13[idx] && ma13[idx] > ma55[idx] && today.close > ma55[idx])) return { triggered: false };

  const justAligned = crossedAboveWithin(ma5, ma13, idx, 2) || priceCrossedAboveWithin(kLines, ma55, idx, 2);
  if (!justAligned) return { triggered: false };

  return {
    triggered: true,
    ruleId: 'R16',
    message: `🟢 均线多头排列：MA5 ${ma5[idx].toFixed(2)} > MA13 ${ma13[idx].toFixed(2)} > MA55 ${ma55[idx].toFixed(2)}，股价站上55日线，多头格局确立`,
    extraData: JSON.stringify({ ma5: ma5[idx], ma13: ma13[idx], ma55: ma55[idx] }),
    barIndex: idx
  };
}

// ==================== 预警规则配置（16条） ====================

export const ALERT_RULES: AlertRule[] = [
  // -------- 卖出 / 风险（9条） --------
  {
    id: 'R01',
    name: '巨量异动',
    description: '量≥年最大×0.95或>5日最高×1.2→见顶；否则>5日均量×1.20→异动（合并原R001+R002）',
    category: 'VOLUME' as any,
    level: 'WARNING' as any,
    suggestion: '放量需结合位置判断，天量大概率见顶，减仓',
    isEnabled: true,
    thresholdValue: 1.20
  },
  {
    id: 'R02',
    name: '见顶形态',
    description: '对子顶(高/收接近+上影+放量)或冲高回落(上影>3%+急拉缓跌)，放量升🔴（合并原R003+R014）',
    category: 'PATTERN' as any,
    level: 'CRITICAL' as any,
    suggestion: '典型顶部形态，高位长上影+放量坚决清仓',
    isEnabled: true
  },
  {
    id: 'R03',
    name: '趋势破位',
    description: '破趋势线/破五日线/放量离场/缩量破位四合一，按严重度择优返回一条（合并原R004+R005+R013+R020）',
    category: 'MOVING_AVG' as any,
    level: 'CRITICAL' as any,
    suggestion: '破位及时止盈，破MA60则清仓观望；缩量可能是健康调整',
    isEnabled: true
  },
  {
    id: 'R04',
    name: '5/13死叉',
    description: 'MA5下穿MA13只有卖点没有买点；同步跌破55日线则下跌中继（斐波那契数列均线规则）',
    category: 'MOVING_AVG' as any,
    level: 'WARNING' as any,
    suggestion: '死叉区域不抢反弹，仅考虑卖点；跌破55日线则规避',
    isEnabled: true
  },
  {
    id: 'R05',
    name: '跌破55日线',
    description: '收盘跌破MA55进入非多头区域，55日线定大势（斐波那契数列均线规则）',
    category: 'MOVING_AVG' as any,
    level: 'WARNING' as any,
    suggestion: '非多头区域不轻易做多，等待重新站上55日线',
    isEnabled: true
  },
  {
    id: 'R06',
    name: '急跌预警',
    description: '单日跌幅<-7%',
    category: 'PRICE' as any,
    level: 'CRITICAL' as any,
    suggestion: '暴跌止损',
    isEnabled: true
  },
  {
    id: 'R07',
    name: '连阳过热',
    description: '三连阳/连2天大涨3%-5.5%/超大阳线>5.5%，择优返回（合并原R006+R007）',
    category: 'PATTERN' as any,
    level: 'WARNING' as any,
    suggestion: '多头衰竭，逐步止盈',
    isEnabled: true
  },
  {
    id: 'R08',
    name: '妇联定律',
    description: '工业富联sh601138大涨>8%预警',
    category: 'SENTIMENT' as any,
    level: 'CRITICAL' as any,
    suggestion: '警惕科技板块大分歧，减仓',
    isEnabled: true
  },
  {
    id: 'R09',
    name: '第二波见顶',
    description: '近期成交量接近第一波高潮',
    category: 'VOLUME' as any,
    level: 'CRITICAL' as any,
    suggestion: '二波高潮可能见顶，止盈',
    isEnabled: true
  },
  // -------- 买入 / 机会（7条） --------
  {
    id: 'R10',
    name: '5/13金叉',
    description: 'MA5上穿MA13；放量+站上55日线→强买(A级)，否则谨慎(B级)（升级原R028）',
    category: 'OPPORTUNITY' as any,
    level: 'INFO' as any,
    suggestion: '金叉可考虑买点，缩量或未站上55日线时结合MACD确认',
    isEnabled: true
  },
  {
    id: 'R11',
    name: '止跌企稳',
    description: '抛压释放(>10%)+新低区锤子线(下影≥实体×2+上影<1%)或十字星',
    category: 'OPPORTUNITY' as any,
    level: 'INFO' as any,
    suggestion: '经典锤子线企稳信号，结合量能确认低吸',
    isEnabled: true
  },
  {
    id: 'R12',
    name: 'RSI底部',
    description: 'RSI底背离(价格新低+RSI未新低)或RSI(6)<20超卖，背离优先（合并原R018+R019）',
    category: 'RSI' as any,
    level: 'INFO' as any,
    suggestion: '超卖/底背离适合逢低布局，结合趋势确认',
    isEnabled: true
  },
  {
    id: 'R13',
    name: '反包入场',
    description: '回调后放量反包突破',
    category: 'OPPORTUNITY' as any,
    level: 'INFO' as any,
    suggestion: '企稳反包，考虑入场',
    isEnabled: true
  },
  {
    id: 'R14',
    name: '黄金位反弹',
    description: '回调至黄金位(38.2%-61.8%)放量反弹',
    category: 'OPPORTUNITY' as any,
    level: 'INFO' as any,
    suggestion: '黄金支撑反弹，入场机会',
    isEnabled: true
  },
  {
    id: 'R15',
    name: '箱体信号',
    description: '箱体突破(40日振幅<20%+突破>3%+放量)或箱体吸筹(60日箱体+放量小阳)，突破优先（合并原R012+R023）',
    category: 'OPPORTUNITY' as any,
    level: 'INFO' as any,
    suggestion: '箱体突破是趋势启动信号，可试探性建仓',
    isEnabled: true
  },
  {
    id: 'R16',
    name: '均线多头排列',
    description: 'MA5>MA13>MA55且股价站上MA55，且多头排列刚刚形成（新增）',
    category: 'MOVING_AVG' as any,
    level: 'INFO' as any,
    suggestion: '多头格局确立，可考虑顺势布局',
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
      case 'R01': result = checkVolumeAbnormal(kLines, quote, rule); break;
      case 'R02': result = checkTopPattern(kLines, quote, rule); break;
      case 'R03': result = checkTrendBreak(kLines, quote, rule); break;
      case 'R04': result = checkMa5Cross13Death(kLines, quote, rule); break;
      case 'R05': result = checkBreakMa55(kLines, quote, rule); break;
      case 'R06': result = checkSuddenDrop(kLines, quote, rule); break;
      case 'R07': result = checkOverheat(kLines, quote, rule); break;
      case 'R08': result = checkFuliLaw(kLines, quote, rule); break;
      case 'R09': result = checkSecondWaveVolume(kLines, quote, rule); break;
      case 'R10': result = checkMa5Cross13Golden(kLines, quote, rule); break;
      case 'R11': result = checkBottomStabilize(kLines, quote, rule); break;
      case 'R12': result = checkRsiBottom(kLines, quote, rule); break;
      case 'R13': result = checkReboundEntry(kLines, quote, rule); break;
      case 'R14': result = checkGoldenRebound(kLines, quote, rule); break;
      case 'R15': result = checkBoxSignal(kLines, quote, rule); break;
      case 'R16': result = checkMaBullAlignment(kLines, quote, rule); break;
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
 * 将触发的规则按可信度分为两组：A级(强信号) / B级(参考信号)
 */
const RULE_RELIABILITY: Record<string, { level: string; role: string }> = {
  R01: { level: 'A', role: '通用' },
  R02: { level: 'A', role: '通用' },
  R03: { level: 'A', role: '风控专家' },
  R04: { level: 'B', role: '技术分析师' },
  R05: { level: 'B', role: '技术分析师' },
  R06: { level: 'A', role: '通用' },
  R07: { level: 'A', role: '通用' },
  R08: { level: 'A', role: '通用' },
  R09: { level: 'A', role: '通用' },
  R10: { level: 'A', role: '技术分析师' },
  R11: { level: 'A', role: '通用' },
  R12: { level: 'A', role: '技术分析师' },
  R13: { level: 'B', role: '技术分析师' },
  R14: { level: 'B', role: '技术分析师' },
  R15: { level: 'B', role: '技术分析师' },
  R16: { level: 'B', role: '技术分析师' },
};

/**
 * 以分级格式返回触发规则描述，用于注入 AI prompt
 * 强信号(A级) → AI 应高度重视
 * 参考信号(B级) → AI 可结合其他因素判断
 */
export function formatTriggeredRulesForAI(results: RuleCheckResult[]): string {
  if (!results || results.length === 0) return '无';

  const strong: string[] = [];
  const reference: string[] = [];

  for (const r of results) {
    if (!r.ruleId) continue;
    const info = RULE_RELIABILITY[r.ruleId];
    const tag = info ? `[${info.level}级·${info.role}]` : '';
    const text = `${r.message} ${tag}`;

    if (info?.level === 'B') {
      reference.push(text);
    } else {
      strong.push(text);
    }
  }

  let output = '';
  if (strong.length > 0) output += `🔴 强信号（需高度重视）：\n${strong.map(s => `  - ${s}`).join('\n')}\n`;
  if (reference.length > 0) output += `🟡 参考信号（结合其他因素判断）：\n${reference.map(s => `  - ${s}`).join('\n')}`;

  return output || '无';
}
