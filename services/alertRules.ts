import { KLineData, RealtimeQuote, AlertRule, RuleCheckResult } from '@/types';
import { calculateMA as calcMAValues, calcRSISeries } from '@/lib/indicators';
import { splitKLines } from '@/lib/stock-helpers';
import type { ChipDistribution } from '@/lib/chip';

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
 * 涨停涨跌幅比例：创业板(30x)/科创板(688)=20%，ST=5%，其余主板=10%。
 * code 可带 "sh"/"sz" 前缀；无 code 时按主板 10% 兜底。
 */
function limitUpPct(code: string, name: string): number {
  const digits = code.replace(/^[a-zA-Z]+/, '');
  if (digits.startsWith('688') || digits.startsWith('30')) return 0.20;
  if (name && name.toUpperCase().includes('ST')) return 0.05;
  return 0.10;
}

/** K线形态分类结果 — 统一形态定义，替代散落的影线百分比/锤子线内联逻辑 */
interface CandleShape {
  body: number;            // 实体高度 |close-open|
  upperShadow: number;     // 上影长度（绝对值）
  lowerShadow: number;     // 下影长度（绝对值）
  totalRange: number;      // 当日振幅 high-low
  upperShadowPct: number;  // 上影占收盘价百分比
  lowerShadowPct: number;  // 下影占收盘价百分比
  isDoji: boolean;         // 十字星：实体极小
  isLongUpper: boolean;    // 长上影：上影≥实体×2 且 下影<实体
  isLongLower: boolean;    // 长下影：下影≥实体×2 且 上影<实体
  isSpinning: boolean;     // 纺锤线：上影≥实体×1.5 且 下影≥实体×1.5 且 实体<振幅1/4
}

/**
 * 统一K线形态分类（长上影/长下影/纺锤线/十字星）。
 * 定义严格按用户规则：用影线/实体比，长上影与纺锤线互斥、长下影与纺锤线互斥。
 * 长上影/长下影/纺锤线方向中性——是顶部还是底部信号由调用方按位置上下文判断（R02 顶部 vs R11 底部）。
 */
function classifyCandle(k: KLineData): CandleShape {
  const body = Math.abs(k.close - k.open);
  const bodyTop = Math.max(k.open, k.close);
  const bodyBottom = Math.min(k.open, k.close);
  const upperShadow = k.high - bodyTop;
  const lowerShadow = bodyBottom - k.low;
  const totalRange = k.high - k.low;
  const upperShadowPct = k.close !== 0 ? (upperShadow / k.close) * 100 : 0;
  const lowerShadowPct = k.close !== 0 ? (lowerShadow / k.close) * 100 : 0;

  const isDoji = k.open !== 0 && body / k.open < 0.005;
  const hasBody = body > 0;
  const isLongUpper = hasBody && upperShadow >= body * 2 && lowerShadow < body;
  const isLongLower = hasBody && lowerShadow >= body * 2 && upperShadow < body;
  const isSpinning = hasBody && upperShadow >= body * 1.5 && lowerShadow >= body * 1.5 && totalRange > 0 && body < totalRange / 4;

  return { body, upperShadow, lowerShadow, totalRange, upperShadowPct, lowerShadowPct, isDoji, isLongUpper, isLongLower, isSpinning };
}

/**
 * 跳空高开百分比：当日开盘相对前收的跳空幅度（R02 跳空衰竭用）
 */
function gapUpPercent(k: KLineData, prevClose: number): number {
  if (!prevClose || prevClose === 0) return 0;
  return ((k.open - prevClose) / prevClose) * 100;
}

/**
 * 近 n 根 K 线是否连续收高（每根 close > 前一根 close）。R02 三连阳/连涨上下文用。
 */
function consecutiveUpDays(kLines: KLineData[], idx: number, n: number): boolean {
  if (idx < n) return false;
  for (let i = 0; i < n; i++) {
    if (kLines[idx - i].close <= kLines[idx - i - 1].close) return false;
  }
  return true;
}

/**
 * 均线是否连续 n 根下行（拐头向下）。R04 档1 MA5 拐头检测用。
 */
function maTurningDown(maArr: number[], idx: number, n: number): boolean {
  if (idx < n) return false;
  for (let i = 0; i < n; i++) {
    const cur = maArr[idx - i];
    const prev = maArr[idx - i - 1];
    if (isNaN(cur) || isNaN(prev) || cur >= prev) return false;
  }
  return true;
}

/**
 * 近期是否处于上涨趋势（R02 见顶形态的位置上下文：连续上涨后）。
 * 三连阳 或 近3日涨幅>5% 视为"连续上涨后"。
 */
function isUptrendRecently(kLines: KLineData[], idx: number): boolean {
  if (consecutiveUpDays(kLines, idx, 3)) return true;
  if (idx >= 3) {
    const ref = kLines[idx - 3].close;
    if (ref > 0 && kLines[idx].close > ref * 1.05) return true;
  }
  return false;
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
 * R02: 见顶阶梯 — 吸收原 R01(巨量见顶) + R02(见顶形态) + R07(连阳过热)
 * 把所有"见顶/过热/量能出逃"信号合并到一个阶梯，内部按严重度择优返回主信号，
 * extraData 列出全部命中的子信号（供 UI 展示）。这样同类信号在一个规则内统一力度，杜绝跨规则矛盾。
 *
 * 子信号严重度：对子顶(5) > 巨量见顶/第二波见顶/长上影+放量/涨停炸板(4) > 长上影/跳空衰竭/纺锤线/长下影见顶(3) > 涨停封板(2) > 巨量异动(1)
 * K线形态均要求"连续上涨后"上下文；长下影在连涨后=顶部承接乏力（R02），在下跌末段=底部锤子（R11），同形态靠位置分流。
 */
function checkTopPattern(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 5) return { triggered: false };
  const idx = kLines.length - 1;
  const today = kLines[idx];
  const prev1 = kLines[idx - 1];
  const shape = classifyCandle(today);
  const avg5 = calculateAvgVolume(kLines.slice(0, -1), 5);
  const isHighVol = avg5 > 0 && today.volume > avg5 * 1.2;
  const uptrend = isUptrendRecently(kLines, idx);
  const threshold = rule.thresholdValue ?? 1.20;

  // 量能信号（原 R01）
  const maxYear = Math.max(...kLines.map(k => k.volume));
  const max5 = calculateMaxVolume(kLines.slice(0, -1), 5);
  let secondWave = false;
  if (kLines.length >= 60) {
    const firstWaveMax = Math.max(...kLines.slice(0, -1).map(k => k.volume));
    const recentMax = Math.max(...kLines.slice(-10).map(k => k.volume));
    if (firstWaveMax > 0 && recentMax >= firstWaveMax * 0.9) secondWave = true;
  }
  const isPeak = today.volume >= maxYear * 0.95 || (max5 > 0 && today.volume > max5 * 1.2);
  const isVolumeAbnormal = avg5 > 0 && today.volume > avg5 * threshold;

  // [severity, label, message]
  const triggered: Array<[number, string, string]> = [];

  // 对子顶（最强）
  const highMatch = Math.abs(today.high - prev1.high) / prev1.high < 0.001;
  const closeMatch = Math.abs(today.close - prev1.close) / prev1.close < 0.001;
  if ((highMatch || closeMatch) && shape.upperShadowPct > 2.5 && isHighVol) {
    triggered.push([5, '对子顶', `🔴 对子顶：高点/收盘接近+上影 ${shape.upperShadowPct.toFixed(1)}% + 放量！双顶结构成型，止盈减仓`]);
  }
  // 巨量见顶 / 第二波见顶
  if (isPeak) {
    triggered.push([4, '巨量见顶', `🔴 巨量见顶：成交量 ${today.volume}，5日最高 ${max5}，年最高 ${maxYear}，天量大概率见顶，止盈减仓`]);
  }
  if (secondWave) {
    triggered.push([4, '第二波见顶', `🔴 第二波见顶：近期量能接近第一波高潮，资金兑现出逃，止盈`]);
  }
  // K线形态（要求"连续上涨后"上下文）
  if (uptrend) {
    if (shape.isLongUpper) {
      triggered.push([isHighVol ? 4 : 3, '长上影见顶', `${isHighVol ? '🔴' : '⚠️'} 长上影见顶：上影 ${shape.upperShadowPct.toFixed(1)}%（≥实体2倍）${isHighVol ? '+放量' : ''}，上方抛压沉重，止盈`]);
    }
    const gap = gapUpPercent(today, prev1.close);
    const smallBody = shape.body > 0 && shape.body / today.close < 0.015;
    if (gap > 0.5 && smallBody && shape.upperShadow > 0 && shape.lowerShadow > 0) {
      triggered.push([3, '跳空衰竭', `⚠️ 跳空衰竭：跳空高开 ${gap.toFixed(1)}% 收小阳+双向影线，多头动能衰竭，止盈`]);
    }
    if (shape.isSpinning) {
      triggered.push([3, '纺锤线见顶', `⚠️ 纺锤线见顶：实体极小+双向长影，多空分歧极大，顶部信号，止盈`]);
    }
    if (shape.isLongLower) {
      triggered.push([3, '长下影见顶', `⚠️ 长下影见顶：下影 ${shape.lowerShadowPct.toFixed(1)}%（≥实体2倍），连续上涨后多头承接无力，空头反扑，止盈`]);
    }
  }
  // 涨停（触及涨停价，注意开板风险）
  const limitPct = limitUpPct(quote?.code ?? '', quote?.name ?? '');
  const prevClose = quote?.preClose ?? (idx >= 1 ? kLines[idx - 1].close : today.close);
  if (prevClose > 0) {
    const limitPrice = Math.round(prevClose * (1 + limitPct) * 100) / 100;
    if (today.high >= limitPrice - 0.001) {
      const sealed = today.close >= limitPrice - 0.001;
      if (sealed) {
        triggered.push([2, '涨停封板', `⚠️ 涨停封板：触及涨停(${limitPrice.toFixed(2)})并封住，注意明日开板风险，追高谨慎`]);
      } else {
        triggered.push([4, '涨停炸板', `🔴 涨停炸板：触及涨停(${limitPrice.toFixed(2)})后回落开板，追高风险大，止盈减仓`]);
      }
    }
  }
  // 巨量异动（最弱）
  if (isVolumeAbnormal && !isPeak) {
    triggered.push([1, '巨量异动', `⚠️ 巨量异动：成交量 ${today.volume}，近5日均量 ${Math.round(avg5)}，放量 ${Math.round(today.volume / avg5 * 100 - 100)}%`]);
  }

  if (triggered.length === 0) return { triggered: false };
  triggered.sort((a, b) => b[0] - a[0]);
  const [, mainLabel, mainMsg] = triggered[0];
  return {
    triggered: true,
    ruleId: 'R02',
    message: mainMsg,
    extraData: JSON.stringify({ main: mainLabel, triggered: triggered.map(t => t[1]) }),
    barIndex: idx
  };
}

/**
 * R04: 离场阶梯 — 吸收原 R03(趋势支撑破位) + R04(阶梯离场) + R06(急跌)
 * 把所有"破位/离场"信号合并到一个阶梯，内部按严重度择优返回主信号，
 * extraData 列出全部命中的子信号。同类信号在一个规则内统一力度，杜绝"一条清仓一条减仓"的跨规则矛盾。
 *
 * 子信号严重度：急跌(5) > 5/13死叉/5/10死叉/破趋势线+破MA60(4,清仓) > 有效跌破10日线/放量离场(3,大减仓) > 跌破5日线/破趋势线(2,减仓) > 跌破10日线待确认/MA5拐头(1,适当减仓) > 缩量破位(0,观望)
 * 死叉清仓覆盖前序减仓；10日线为卖出主线（控回撤），买入仍看 5/13 金叉（R10）。
 */
function checkTieredExit(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 6) return { triggered: false };
  const idx = kLines.length - 1;
  const today = kLines[idx];
  const prev1 = kLines[idx - 1];
  const ma5 = calculateMA(kLines, 5);
  const ma10 = calculateMA(kLines, 10);
  const ma13 = calculateMA(kLines, 13);
  const avg5 = calculateAvgVolume(kLines.slice(0, -1), 5);
  const volRatio = avg5 > 0 ? today.volume / avg5 : 1;
  const trendLine = kLines.slice(-10).reduce((s, k) => s + k.low, 0) / 10;

  // [severity, label, message]
  const triggered: Array<[number, string, string]> = [];

  // 急跌（原 R06）— 先抛
  const change = calculateChangePercent(today.close, prev1.close);
  if (change < -7.0) {
    triggered.push([5, '急跌', `🔴 急跌：暴跌 ${change.toFixed(2)}%，先抛再说！`]);
  }

  // 5/13 死叉（原 R04档4）— 清仓，波段反转
  if (kLines.length >= 14 && crossedBelowWithin(ma5, ma13, idx, 2)) {
    let belowMa55 = false; let ma55 = 0;
    if (kLines.length >= 55) {
      ma55 = calculateMA(kLines, 55)[idx];
      belowMa55 = ma55 > 0 && today.close < ma55;
    }
    const msg = belowMa55
      ? `🔴 5/13死叉，波段反转，清仓（MA5 ${ma5[idx].toFixed(2)} < MA13 ${ma13[idx].toFixed(2)}，同步跌破55日线 ${ma55.toFixed(2)}，下跌中继风险，规避）`
      : `🔴 5/13死叉，波段反转，清仓（MA5 ${ma5[idx].toFixed(2)} < MA13 ${ma13[idx].toFixed(2)}）`;
    triggered.push([4, '5/13死叉', msg]);
  }

  // 5/10 死叉（原 R04档3）— 清仓，短期反转
  if (kLines.length >= 14 && crossedBelowWithin(ma5, ma10, idx, 2)) {
    triggered.push([4, '5/10死叉', `🔴 5/10死叉，短期趋势反转，清仓（MA5 ${ma5[idx].toFixed(2)} < MA10 ${ma10[idx].toFixed(2)}）`]);
  }

  // 破趋势线+破MA60（原 R03）— 清仓，牛熊分界
  if (kLines.length >= 60) {
    const ma60 = calculateMA(kLines, 60)[idx];
    if (today.close < trendLine && prev1.close < trendLine && today.volume > prev1.volume * 1.05 && ma60 > 0 && today.close < ma60) {
      triggered.push([4, '破趋势线+破MA60', `🔴🔴 趋势破位+破MA60：收盘 ${today.close}，趋势支撑 ${trendLine.toFixed(2)}，MA60 ${ma60.toFixed(2)}——牛熊分界已破，清仓观望`]);
    }
  }

  // 有效跌破10日线（原 R04档2b）— 减仓70-80%
  if (!isNaN(ma10[idx]) && ma10[idx] > 0 && idx >= 2) {
    const belowNow = today.close < ma10[idx];
    const belowPrev = kLines[idx - 1].close < ma10[idx - 1];
    const abovePrev2 = kLines[idx - 2].close >= ma10[idx - 2];
    if (belowNow && belowPrev && abovePrev2) {
      triggered.push([3, '有效跌破10日线', `🔴 有效跌破10日线，减仓70-80%（收盘 ${today.close} < MA10 ${ma10[idx].toFixed(2)}，连续两日未收回）`]);
    } else if (belowNow && !belowPrev) {
      triggered.push([1, '跌破10日线待确认', `⚠️ 跌破10日线（待确认，次日未收回方有效），适当减仓（收盘 ${today.close} < MA10 ${ma10[idx].toFixed(2)}）`]);
    }
  }

  // 放量离场（原 R03）— 减仓
  if (volRatio >= 2.0 && (today.close < ma5[idx] || today.close < trendLine)) {
    triggered.push([3, '放量离场', `🔴 放量离场：量比 ${volRatio.toFixed(1)}倍 + 价格破位（收${today.close}），果断离场！`]);
  }

  // 跌破5日线（原 R03）— 减仓
  if (!isNaN(ma5[idx]) && today.close < ma5[idx] && today.volume > prev1.volume * 1.1) {
    triggered.push([2, '跌破5日线', `${volRatio > 2.0 ? '🔴' : '⚠️'} 破五日线：收盘 ${today.close}，MA5 ${ma5[idx].toFixed(2)}，放量跌破`]);
  }

  // 破趋势线（原 R03，未破MA60）— 减仓
  if (kLines.length >= 60 && today.close < trendLine && prev1.close < trendLine && today.volume > prev1.volume * 1.05) {
    triggered.push([2, '破趋势线', `🔴 趋势破位：收盘 ${today.close}，趋势支撑 ${trendLine.toFixed(2)}，放量跌破`]);
  }

  // MA5 拐头（原 R04档1）— 减仓30-40%
  if (maTurningDown(ma5, idx, 2)) {
    triggered.push([1, 'MA5拐头', `⚠️ MA5拐头向下，趋势转弱，减仓30-40%（MA5 ${ma5[idx].toFixed(2)} → ${ma5[idx - 1].toFixed(2)} → ${ma5[idx - 2].toFixed(2)}）`]);
  }

  // 缩量破位（原 R03）— 观望
  if (!isNaN(ma5[idx]) && today.close < ma5[idx] && today.volume < prev1.volume * 0.9 && prev1.close < ma5[idx - 1]) {
    triggered.push([0, '缩量破位', `🟡 缩量破位：连续两日收<MA5，缩量，减仓观望`]);
  }

  if (triggered.length === 0) return { triggered: false };
  triggered.sort((a, b) => b[0] - a[0]);
  const [, mainLabel, mainMsg] = triggered[0];
  return {
    triggered: true,
    ruleId: 'R04',
    message: mainMsg,
    extraData: JSON.stringify({ main: mainLabel, triggered: triggered.map(t => t[1]) }),
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

  const shape = classifyCandle(today);
  // 锤子线（底部承接）：下影≥实体×2 + 下影>2% + 上影<1%。与 R02 顶部"长下影见顶"靠位置上下文分流。
  const isHammer = shape.body > 0 && shape.lowerShadow >= shape.body * 2 && shape.lowerShadowPct > 2.0 && shape.upperShadowPct < 1.0;

  let sig = '';
  if (isHammer) sig = `锤子线（下影${shape.lowerShadowPct.toFixed(1)}%，实体${(shape.body / today.open * 100).toFixed(1)}%）`;
  else if (shape.isDoji) sig = '十字星';

  if (sig) {
    return {
      triggered: true,
      ruleId: 'R11',
      message: `🟢 止跌企稳：抛压已释放 ${(dropRange * 100).toFixed(0)}%，新低区域出现${sig}，关注低吸`,
      extraData: JSON.stringify({ dropRange, lowerShadowPct: shape.lowerShadowPct, isHammer }),
      barIndex: idx
    };
  }
  return { triggered: false };
}

/**
 * R12: RSI 超卖 — 原 R018。底背离分支已移除（左侧抄底胜率低、可连续多次背离，
 * 信号质量差），底部信号统一交给 R11 止跌企稳（右侧K线确认）。
 * 仅保留 RSI(6)<20 超卖，并加趋势过滤：强下行趋势（MA20 下行 + 收盘破 MA20）
 * 中的超卖可靠性低（接飞刀），不报。
 */
function checkRsiBottom(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 25) return { triggered: false };
  const idx = kLines.length - 1;
  const today = kLines[idx];

  // 趋势过滤：强下行趋势中超卖信号不报，避免接飞刀
  const ma20 = calculateMA(kLines, 20);
  const ma20Now = ma20[idx];
  const ma20Prev5 = ma20[idx - 5];
  if (ma20Now > 0 && ma20Prev5 > 0 && ma20Now < ma20Prev5 && today.close < ma20Now) {
    return { triggered: false };
  }

  // RSI(6) 超卖
  const rsi6 = calculateRSI(kLines, 6);
  if (rsi6 < 20) {
    return {
      triggered: true,
      ruleId: 'R12',
      message: `🟢 RSI超卖：RSI(6)=${rsi6.toFixed(1)} < 20，进入超卖区（非强下行趋势），适合逢低布局`,
      extraData: JSON.stringify({ rsi6 }),
      barIndex: idx
    };
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

/**
 * R17: 站稳五日线加仓 — 连续3日收盘站上MA5，且MA5上行、站稳刚刚形成
 * （站稳前一日在MA5之下，避免上行趋势中每日重复触发）。加仓信号。
 */
function checkHoldMa5(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  const holdDays = 3;
  if (kLines.length < 8) return { triggered: false };
  const idx = kLines.length - 1;
  const ma5 = calculateMA(kLines, 5);

  // 连续3日收盘站上MA5
  for (let i = 0; i < holdDays; i++) {
    if (!(ma5[idx - i] > 0 && kLines[idx - i].close > ma5[idx - i])) return { triggered: false };
  }
  // 站稳刚刚形成：站稳前一日收盘在MA5之下（否则上行趋势中会每日触发）
  if (!(ma5[idx - holdDays] > 0 && kLines[idx - holdDays].close <= ma5[idx - holdDays])) return { triggered: false };
  // MA5上行确认，过滤横盘假站稳
  if (!(ma5[idx] > ma5[idx - holdDays])) return { triggered: false };

  return {
    triggered: true,
    ruleId: 'R17',
    message: `🟢 站稳五日线：连续3日收盘站上MA5（${ma5[idx].toFixed(2)}），MA5上行，强势确立可考虑加仓`,
    extraData: JSON.stringify({ ma5: ma5[idx], holdDays }),
    barIndex: idx
  };
}

// ==================== 筹码峰弱提醒（R18 买 / R19 卖，B级参考，不计入共振硬聚合） ====================

/**
 * R18 筹码低位密集（买入弱提醒）
 * 触发：90%集中度<0.18（密集）AND 获利盘>0.6 AND 主峰≤现价×1.03（峰在附近或下方）
 * 数据来源：调用方从 DB 取筹码分布传入（chip 参数），缺数据不触发
 */
function checkChipLowConcentrate(
  kLines: KLineData[], quote: RealtimeQuote | null, _rule: AlertRule, chip?: ChipDistribution | null
): RuleCheckResult {
  if (!chip) return { triggered: false };
  const price = quote?.price ?? kLines[kLines.length - 1]?.close;
  if (!price) return { triggered: false };

  if (chip.concentration90 < 0.18 && chip.profitRatio > 0.6 && chip.dominantPeak <= price * 1.03) {
    return {
      triggered: true,
      ruleId: 'R18',
      message: `🟡 筹码低位密集：90%集中度${chip.concentration90.toFixed(3)}，获利盘${(chip.profitRatio * 100).toFixed(0)}%，主峰${chip.dominantPeak.toFixed(2)}接近/低于现价，结构偏多（参考级）`,
      extraData: JSON.stringify({ concentration90: chip.concentration90, profitRatio: chip.profitRatio, dominantPeak: chip.dominantPeak, avgCost: chip.avgCost }),
    };
  }
  return { triggered: false };
}

/**
 * R19 筹码高位套牢（卖出弱提醒）
 * 触发：获利盘<0.4 AND 主峰>现价×1.05（上方重峰）AND 20日涨幅>15%（避免底部误判）
 */
function checkChipHighTrap(
  kLines: KLineData[], quote: RealtimeQuote | null, _rule: AlertRule, chip?: ChipDistribution | null
): RuleCheckResult {
  if (!chip || kLines.length < 21) return { triggered: false };
  const price = quote?.price ?? kLines[kLines.length - 1]?.close;
  if (!price) return { triggered: false };

  const c20 = kLines[kLines.length - 21].close;
  const ret20d = c20 > 0 ? ((kLines[kLines.length - 1].close - c20) / c20) * 100 : 0;

  if (chip.profitRatio < 0.4 && chip.dominantPeak > price * 1.05 && ret20d > 15) {
    return {
      triggered: true,
      ruleId: 'R19',
      message: `🟡 筹码高位套牢：获利盘仅${(chip.profitRatio * 100).toFixed(0)}%，主峰${chip.dominantPeak.toFixed(2)}高于现价，20日涨${ret20d.toFixed(0)}%后上方压力大（参考级）`,
      extraData: JSON.stringify({ profitRatio: chip.profitRatio, dominantPeak: chip.dominantPeak, ret20d }),
    };
  }
  return { triggered: false };
}

// ==================== 预警规则配置（12条） ====================

export const ALERT_RULES: AlertRule[] = [
  // -------- 卖出 / 风险（4条：2个阶梯 + R05 + R08） --------
  {
    id: 'R02',
    name: '见顶阶梯',
    description: '见顶/过热/量能出逃信号合并阶梯：对子顶/巨量见顶/第二波见顶/长上影/跳空衰竭/纺锤线/长下影见顶/涨停封板/涨停炸板/巨量异动，按严重度择优，extraData列出全部命中子信号（吸收原R01+R02+R07；连阳过热/连2天大涨/超大阳线已删，改为涨停封板/涨停炸板）',
    category: 'PATTERN' as any,
    level: 'CRITICAL' as any,
    suggestion: '见顶信号，适当减仓；对子顶/巨量见顶等强信号应更果断',
    isEnabled: true,
    thresholdValue: 1.20
  },
  {
    id: 'R04',
    name: '离场阶梯',
    description: '破位/离场信号合并阶梯：急跌/5/13死叉/5/10死叉/破趋势线+破MA60/有效跌破10日线/放量离场/跌破5日线/破趋势线/MA5拐头/跌破10日线待确认/缩量破位，按严重度择优，extraData列出全部命中子信号（吸收原R03+R04+R06）',
    category: 'MOVING_AVG' as any,
    level: 'CRITICAL' as any,
    suggestion: '阶梯减仓控回撤：拐头/破5日线先减、有效破10日线大减、死叉/急跌/破MA60清仓；10日线为卖出主线',
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
    id: 'R08',
    name: '妇联定律',
    description: '工业富联sh601138大涨>8%预警',
    category: 'SENTIMENT' as any,
    level: 'CRITICAL' as any,
    suggestion: '警惕科技板块大分歧，减仓',
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
    name: 'RSI超卖',
    description: 'RSI(6)<20超卖，且非强下行趋势（MA20下行+破MA20时过滤，避免接飞刀）。底背离分支已移除，底部统一由R11止跌企稳覆盖',
    category: 'RSI' as any,
    level: 'INFO' as any,
    suggestion: '超卖适合逢低布局，结合趋势确认',
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
  },
  {
    id: 'R17',
    name: '站稳五日线加仓',
    description: '连续3日收盘站上MA5且MA5上行，站稳刚刚形成（站稳前一日在MA5之下），加仓信号',
    category: 'OPPORTUNITY' as any,
    level: 'INFO' as any,
    suggestion: '反弹站稳五日线，强势确立可考虑加仓',
    isEnabled: true
  },
  // -------- 筹码峰弱提醒（2条，B级参考，不计入共振硬聚合） --------
  {
    id: 'R18',
    name: '筹码低位密集',
    description: '筹码90%集中度<0.18且获利盘>60%且主峰接近/低于现价，结构偏多（参考级，数据来自daily_bars换手率转移模型）',
    category: 'PATTERN' as any,
    level: 'INFO' as any,
    suggestion: '筹码低位密集，主力成本区在下方，结合趋势与量能综合判断（参考级，不作为一票通过）',
    isEnabled: true
  },
  {
    id: 'R19',
    name: '筹码高位套牢',
    description: '获利盘<40%且主峰高于现价5%且20日涨幅>15%，上方套牢盘重（参考级）',
    category: 'PATTERN' as any,
    level: 'WARNING' as any,
    suggestion: '上方筹码峰压力大，追高需谨慎（参考级，不作为一票否决）',
    isEnabled: true
  }
];

/**
 * 检查所有启用的规则
 */
export function checkAllRules(
  kLines: KLineData[],
  quote: RealtimeQuote | null,
  enabledRules: AlertRule[] = ALERT_RULES.filter(r => r.isEnabled),
  chip?: ChipDistribution | null
): RuleCheckResult[] {
  const results: RuleCheckResult[] = [];

  for (const rule of enabledRules) {
    let result: RuleCheckResult;
    switch (rule.id) {
      case 'R02': result = checkTopPattern(kLines, quote, rule); break;
      case 'R04': result = checkTieredExit(kLines, quote, rule); break;
      case 'R05': result = checkBreakMa55(kLines, quote, rule); break;
      case 'R08': result = checkFuliLaw(kLines, quote, rule); break;
      case 'R10': result = checkMa5Cross13Golden(kLines, quote, rule); break;
      case 'R11': result = checkBottomStabilize(kLines, quote, rule); break;
      case 'R12': result = checkRsiBottom(kLines, quote, rule); break;
      case 'R13': result = checkReboundEntry(kLines, quote, rule); break;
      case 'R14': result = checkGoldenRebound(kLines, quote, rule); break;
      case 'R15': result = checkBoxSignal(kLines, quote, rule); break;
      case 'R16': result = checkMaBullAlignment(kLines, quote, rule); break;
      case 'R17': result = checkHoldMa5(kLines, quote, rule); break;
      case 'R18': result = checkChipLowConcentrate(kLines, quote, rule, chip); break;
      case 'R19': result = checkChipHighTrap(kLines, quote, rule, chip); break;
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
  R02: { level: 'A', role: '通用' },
  R04: { level: 'A', role: '风控专家' },
  R05: { level: 'B', role: '技术分析师' },
  R08: { level: 'A', role: '通用' },
  R10: { level: 'A', role: '技术分析师' },
  R11: { level: 'A', role: '通用' },
  R12: { level: 'A', role: '技术分析师' },
  R13: { level: 'B', role: '技术分析师' },
  R14: { level: 'B', role: '技术分析师' },
  R15: { level: 'B', role: '技术分析师' },
  R16: { level: 'B', role: '技术分析师' },
  R17: { level: 'B', role: '技术分析师' },
  R18: { level: 'B', role: '结构参考' },
  R19: { level: 'B', role: '结构参考' },
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

/**
 * 卖出/风险侧规则 ID（与 ALERT_RULES 分组同源：R02/R04/R05/R08/R19）。
 * R19 筹码高位套牢归卖出侧。其余 ruleId 均为买入/机会侧。
 * 用于 UI 把同日多个买入信号聚合成"共振"展示。
 */
export const SELL_RULE_IDS = new Set(['R02', 'R04', 'R05', 'R08', 'R19']);

/** 参考级弱提醒规则 ID（R18/R19）：从买入共振≥2 硬聚合计数剔除，仅作展示提示 */
export const REFERENCE_RULE_IDS = new Set(['R18', 'R19']);

/** 判断 ruleId 是否为买入/机会侧（非卖出/风险侧） */
export function isBuyRule(ruleId?: string): boolean {
  if (!ruleId) return false;
  return !SELL_RULE_IDS.has(ruleId);
}
