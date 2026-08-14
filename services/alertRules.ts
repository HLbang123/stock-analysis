import { KLineData, RealtimeQuote, AlertRule, AlertLevel, RuleCheckResult } from '@/types';
import { calculateMA as calcMAValues, calcRSISeries } from '@/lib/indicators';
import { splitKLines, beijingTodayStr, intradayVolumePace } from '@/lib/stock-helpers';
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
 * 当日起始根 bar 的"等效全日量"：盘中合成 bar 只是半天累积量，
 * 除以时间进度系数折算（非今日 bar / 盘后 pace=1 时原样返回）。
 * 所有"今日量 vs 基线"的放量/缩量判断一律用它，否则上午漏报放量、盘中误报缩量。
 *
 * 折算保护上限（08-05 全规则统一）：折算系数下限 0.5 → 等效量最多 = 当前累积量 × 2。
 * 早盘量能前置(高开抢筹/U形失效)会让 pace 折算把半天量放大多倍，数值虚大导致
 * 巨量见顶/放量离场/反包/箱体突破等所有量能类规则盘中集体误报；
 * 真正的大放量盘后折算=1 不受影响；代价是 10:00 前需当日已接近日均量才算"放量"，可接受。
 */
function effectiveTodayVolume(kLines: KLineData[], quote: RealtimeQuote | null): number {
  const today = kLines[kLines.length - 1];
  if (!today) return 0;
  if (today.date !== beijingTodayStr()) return today.volume; // 周末/节假日：最后一根是已完成日K
  const pace = intradayVolumePace(quote?.updateTime);
  const effVol = pace >= 1 ? today.volume : today.volume / pace;
  return Math.min(effVol, today.volume * 2);
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
 * 长上影/长下影/纺锤线方向中性——是顶部还是底部信号由调用方按位置上下文判断（R01 顶部 vs R06 底部）。
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
 * 跳空高开百分比：当日开盘相对前收的跳空幅度（R01 跳空衰竭用）
 */
function gapUpPercent(k: KLineData, prevClose: number): number {
  if (!prevClose || prevClose === 0) return 0;
  return ((k.open - prevClose) / prevClose) * 100;
}

/**
 * 近 n 根 K 线是否连续收高（每根 close > 前一根 close）。R01 三连阳/连涨上下文用。
 */
function consecutiveUpDays(kLines: KLineData[], idx: number, n: number): boolean {
  if (idx < n) return false;
  for (let i = 0; i < n; i++) {
    if (kLines[idx - i].close <= kLines[idx - i - 1].close) return false;
  }
  return true;
}

/**
 * MA5 拐头（R02 弱提醒）2026-08-10 已删除：全表最大样本(27356) + T+5 胜率 46%≈基准 46.4%（无区分度）
 * + 均值仅 -0.26%（低于交易成本）。趋势转弱信息由 5/13死叉/跌破5日线 完全覆盖；maTurningDown 随同删除。
 */

/**
 * 近期是否处于上涨趋势（R01 见顶形态的位置上下文：连续上涨后）。
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
 * R01: 见顶阶梯 — 见顶/过热/量能出逃信号合并阶梯，内部按严重度择优返回主信号
 * 把所有"见顶/过热/量能出逃"信号合并到一个阶梯，内部按严重度择优返回主信号，
 * extraData 列出全部命中的子信号（供 UI 展示）。这样同类信号在一个规则内统一力度，杜绝跨规则矛盾。
 *
 * 子信号严重度：对子顶(5) > 巨量见顶/第二波见顶/长上影+放量/涨停炸板(4) > 长上影/跳空衰竭/纺锤线/长下影见顶(3) > 涨停封板(2) > 巨量异动(1)
 * K线形态均要求"连续上涨后"上下文；长下影在连涨后=顶部承接乏力（R01），在下跌末段=底部锤子（R06），同形态靠位置分流。
 */
function checkTopPattern(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule, limitMap?: LimitPriceMap | null): RuleCheckResult {
  if (kLines.length < 5) return { triggered: false };
  const idx = kLines.length - 1;
  const today = kLines[idx];
  const prev1 = kLines[idx - 1];
  const shape = classifyCandle(today);
  const avg5 = calculateAvgVolume(kLines.slice(0, -1), 5);
  // 等效全日量（折算保护已内置于 effectiveTodayVolume，全规则统一）
  const effVol = effectiveTodayVolume(kLines, quote);
  const isHighVol = avg5 > 0 && effVol > avg5 * 1.2;
  const uptrend = isUptrendRecently(kLines, idx);
  const threshold = rule.thresholdValue ?? 1.20;

  // 量能信号
  const avg20 = calculateAvgVolume(kLines.slice(0, -1), 20);
  // 位置门槛："巨量见顶"必须先有"顶"——收盘在60日高点92%以内，或近期连续上涨。
  // 否则低位/横盘放量（可能是底部启动）也报"见顶"，且行情热时全市场普涨量会集体误报。
  const high60 = Math.max(...kLines.slice(-60).map(k => k.high));
  const atTop = (high60 > 0 && today.close >= high60 * 0.92) || uptrend;
  // 第二波见顶：第一波高潮后（近5日之外的历史天量），近5日再现接近第一波高潮的放量（≥90%），且仍处高位。
  // 旧实现第一波窗口 slice(0,-1) 只排除今日、却含第二波窗口——历史天量恰在近10日时自己印证自己恒真触发
  // （海康威视 7-27 天量 2.9亿 既当第一波又当第二波，之后量能仅为其 59% 仍每日报"第二波见顶"）。
  // 第一波须是真高潮（≥1.5×20日均量）——否则量能平稳的票，任何普通放量日都会"接近第一波"恒真触发。
  let secondWave = false;
  if (kLines.length >= 30) {
    const firstWaveMax = Math.max(...kLines.slice(0, -5).map(k => k.volume));
    const secondWaveMax = Math.max(...kLines.slice(-5, -1).map(k => k.volume));
    const avg20Wave = calculateAvgVolume(kLines.slice(0, -5), 20);
    if (firstWaveMax > 0 && firstWaveMax >= avg20Wave * 1.5 && secondWaveMax >= firstWaveMax * 0.9 && atTop) secondWave = true;
  }
  // 量能极端：今日等效全日量 ≥ 2 倍 20 日均量（对自身历史自适应，行情热基线同步抬升）。
  // 弃用"120日分位 ≥95%"口径：盘中折算后分位恒饱和到 100%，无区分度且让文案数值虚大。
  const volRatio20 = avg20 > 0 ? effVol / avg20 : 0;
  const volExtreme = volRatio20 >= 2.0;
  // 派发确认：天量必须"没换来价"才算见顶——滞涨(|涨跌幅|<2%) / 阴线 / 长上影(≥3%，2%太常见) 三选一。
  // 放量大阳线/涨停是启动不是派发，交给突破类规则(R08/箱体)报，R01 不两头喊。
  const dayChgPct = prev1.close > 0 ? ((today.close - prev1.close) / prev1.close) * 100 : 0;
  const stagnant = Math.abs(dayChgPct) < 2;
  const bearishCandle = today.close < today.open;
  const rejection = shape.upperShadowPct >= 3;
  const distribution = stagnant || bearishCandle || rejection;
  // 高位 + 量能极端 + 派发痕迹，三条件各管一件事：在哪、量多大、价怎么回应
  const isPeak = atTop && volExtreme && distribution;
  // 巨量异动（severity 1 弱提醒）：用"已成交量"不折算（确认性优先，宁缺毋滥）。
  // 盘中折算依赖"时段量能与历史分布一致"假设，但放量日的量能恰恰最易集中上午
  // （哈药 8/05 11:12 已成交 391万手≈当日全天的 97%，pace 折算却按 50% 估成 781万手 → 误报放量85%）。
  // 强信号（巨量见顶 volRatio20≥2）保留折算抓上午；弱信号等已成交量确认。
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
    const traces: string[] = [];
    if (stagnant) traces.push(`放量滞涨(涨跌幅 ${dayChgPct.toFixed(1)}%)`);
    if (bearishCandle) traces.push('阴线');
    if (rejection) traces.push(`上影 ${shape.upperShadowPct.toFixed(1)}%`);
    triggered.push([4, '巨量见顶', `🔴 巨量见顶：高位天量(量比 ${volRatio20.toFixed(1)})+${traces.join('、')}，派发嫌疑，止盈减仓`]);
  }
  if (secondWave) {
    const firstWaveMax = Math.max(...kLines.slice(0, -5).map(k => k.volume));
    const secondWaveMax = Math.max(...kLines.slice(-5, -1).map(k => k.volume));
    triggered.push([4, '第二波见顶', `🔴 第二波见顶：近5日放量 ${secondWaveMax} 已达第一波高潮(${firstWaveMax})的 ${(secondWaveMax / firstWaveMax * 100).toFixed(0)}%，资金兑现出逃，止盈`]);
  }
  // K线形态（要求"连续上涨后"上下文）
  // 08-05 回测（790票×500日）显示形态类见顶无预测力（胜率≈基准46.4%、均值微正），降级为弱提醒保留观察价值
  if (uptrend) {
    if (shape.isLongUpper) {
      triggered.push([isHighVol ? 3 : 2, '长上影见顶', `${isHighVol ? '🔴' : '⚠️'} 长上影见顶：上影 ${shape.upperShadowPct.toFixed(1)}%（≥实体2倍）${isHighVol ? '+放量' : ''}，上方抛压沉重，止盈`]);
    }
    const gap = gapUpPercent(today, prev1.close);
    const smallBody = shape.body > 0 && shape.body / today.close < 0.015;
    if (gap > 0.5 && smallBody && shape.upperShadow > 0 && shape.lowerShadow > 0) {
      triggered.push([2, '跳空衰竭', `⚠️ 跳空衰竭：跳空高开 ${gap.toFixed(1)}% 收小阳+双向影线，多头动能衰竭，止盈`]);
    }
    if (shape.isSpinning) {
      triggered.push([2, '纺锤线见顶', `⚠️ 纺锤线见顶：实体极小+双向长影，多空分歧极大，顶部信号，止盈`]);
    }
    if (shape.isLongLower) {
      triggered.push([2, '长下影见顶', `⚠️ 长下影见顶：下影 ${shape.lowerShadowPct.toFixed(1)}%（≥实体2倍），连续上涨后多头承接无力，空头反扑，止盈`]);
    }
  }
  // 涨停（触及涨停价，注意开板风险）
  // 精确价优先（stk_limit 表，前端预取）；未命中回落板块规则推算（10%/20%/ST 5%）
  const prevClose = quote?.preClose ?? (idx >= 1 ? kLines[idx - 1].close : today.close);
  if (prevClose > 0) {
    const exactUp = limitMap?.[toTushareCode(quote?.code ?? '')]?.up;
    const limitPrice = exactUp && exactUp > 0 ? exactUp : Math.round(prevClose * (1 + limitUpPct(quote?.code ?? '', quote?.name ?? '')) * 100) / 100;
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
    // 已成交量口径：三个数字同一基数（today.volume / avg5），不再出现"量 391万 < 均量 422万 却放量85%"的矛盾
    triggered.push([1, '巨量异动', `⚠️ 巨量异动：成交量 ${today.volume.toLocaleString()}，近5日均量 ${Math.round(avg5).toLocaleString()}，放量 ${Math.round(today.volume / avg5 * 100 - 100)}%`]);
  }

  if (triggered.length === 0) return { triggered: false };
  triggered.sort((a, b) => b[0] - a[0]);
  const [mainSev, mainLabel, mainMsg] = triggered[0];
  return {
    triggered: true,
    ruleId: 'R01',
    message: mainMsg,
    // sev=主信号严重度：预警页按此分级展示（≥3 强卖出染绿整卡/摘买入徽章，≤2 弱提醒仅行内展示）
    extraData: JSON.stringify({ main: mainLabel, sev: mainSev, triggered: triggered.map(t => t[1]) }),
    barIndex: idx
  };
}

/**
 * R02: 离场阶梯 — 破位/离场信号合并阶梯，内部按严重度择优返回主信号
 * 把所有"破位/离场"信号合并到一个阶梯，内部按严重度择优返回主信号，
 * extraData 列出全部命中的子信号。同类信号在一个规则内统一力度，杜绝"一条清仓一条减仓"的跨规则矛盾。
 *
 * 子信号严重度：急跌(5) > 5/10死叉/破趋势线+破MA60/5/13死叉+跌破55日线(4,清仓) > 有效跌破10日线(3,大减仓) > 跌破5日线/破趋势线/5/13死叉站上55日线(2,减仓) > 跌破10日线待确认(1,适当减仓)
 * 死叉清仓覆盖前序减仓；10日线为卖出主线（控回撤），买入仍看 5/13 金叉（R04）。
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
  const effVol = effectiveTodayVolume(kLines, quote); // 盘中折算等效全日量
  const volRatio = avg5 > 0 ? effVol / avg5 : 1;
  const trendLine = kLines.slice(-10).reduce((s, k) => s + k.low, 0) / 10;

  // [severity, label, message]
  const triggered: Array<[number, string, string]> = [];

  // 急跌 — 先抛
  const change = calculateChangePercent(today.close, prev1.close);
  if (change < -7.0) {
    triggered.push([5, '急跌', `🔴 急跌：暴跌 ${change.toFixed(2)}%，先抛再说！`]);
  }

  // 5/13 死叉 — 波段反转。2026-08-10 回测：T+5 均值 +0.11%（全表唯一为正）、胜率 49%——
  // 上涨趋势里的假死叉（回调后收回）占多数，一律清仓割在低点。同步跌破 MA55（真下跌趋势）才清仓(4)；
  // 站上 MA55 的假死叉降级减仓(2)，不再一票清仓（短均线数据不足 55 根时按降级处理，无法确认下跌中继）
  if (kLines.length >= 14 && crossedBelowWithin(ma5, ma13, idx, 2)) {
    let belowMa55 = false; let ma55 = 0;
    if (kLines.length >= 55) {
      ma55 = calculateMA(kLines, 55)[idx];
      belowMa55 = ma55 > 0 && today.close < ma55;
    }
    const sev = belowMa55 ? 4 : 2;
    const msg = belowMa55
      ? `🔴 5/13死叉+跌破55日线，波段反转，清仓（MA5 ${ma5[idx].toFixed(2)} < MA13 ${ma13[idx].toFixed(2)}，55日线 ${ma55.toFixed(2)} 下方，下跌中继风险，规避）`
      : `⚠️ 5/13死叉（站上55日线，回调型假死叉，减仓观察，暂不清仓）（MA5 ${ma5[idx].toFixed(2)} < MA13 ${ma13[idx].toFixed(2)}）`;
    triggered.push([sev, '5/13死叉', msg]);
  }

  // 5/10 死叉 — 清仓，短期反转
  if (kLines.length >= 14 && crossedBelowWithin(ma5, ma10, idx, 2)) {
    triggered.push([4, '5/10死叉', `🔴 5/10死叉，短期趋势反转，清仓（MA5 ${ma5[idx].toFixed(2)} < MA10 ${ma10[idx].toFixed(2)}）`]);
  }

  // 破趋势线+破MA60 — 清仓，牛熊分界
  if (kLines.length >= 60) {
    const ma60 = calculateMA(kLines, 60)[idx];
    if (today.close < trendLine && prev1.close < trendLine && effVol > prev1.volume * 1.05 && ma60 > 0 && today.close < ma60) {
      triggered.push([4, '破趋势线+破MA60', `🔴🔴 趋势破位+破MA60：收盘 ${today.close}，趋势支撑 ${trendLine.toFixed(2)}，MA60 ${ma60.toFixed(2)}——牛熊分界已破，清仓观望`]);
    }
  }

  // 有效跌破10日线 — 减仓70-80%
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

  // 放量离场 — 已删（08-05 回测：无区分度，胜率45.3%≈基准46.4%、均值-0.01%；破趋势线+破MA60 已覆盖同类场景）

  // 跌破5日线 — 减仓
  if (!isNaN(ma5[idx]) && today.close < ma5[idx] && effVol > prev1.volume * 1.1) {
    triggered.push([2, '跌破5日线', `${volRatio > 2.0 ? '🔴 放量' : '⚠️ 带量'}跌破5日线：收盘 ${today.close}，MA5 ${ma5[idx].toFixed(2)}`]);
  }

  // 破趋势线（未破MA60）— 减仓
  if (kLines.length >= 60 && today.close < trendLine && prev1.close < trendLine && effVol > prev1.volume * 1.05) {
    triggered.push([2, '破趋势线', `🔴 趋势破位：收盘 ${today.close}，趋势支撑 ${trendLine.toFixed(2)}，放量跌破`]);
  }

  // MA5 拐头 — 已删（08-10 回测：样本27356 全表最大、T+5胜率46%≈基准46.4%无区分度、均值-0.26%低于交易成本；
  // 趋势转弱信息由 5/13死叉/跌破5日线 完全覆盖）

  // 缩量破位 — 已删（08-05 回测：反向信号，胜率46.8%高于基准46.4%、均值+0.23%，信号后反而微涨）

  if (triggered.length === 0) return { triggered: false };
  triggered.sort((a, b) => b[0] - a[0]);
  const [mainSev, mainLabel, mainMsg] = triggered[0];
  return {
    triggered: true,
    ruleId: 'R02',
    message: mainMsg,
    // sev=主信号严重度：预警页按此分级展示（≥3 强卖出染绿整卡/摘买入徽章，≤2 弱提醒仅行内展示）
    extraData: JSON.stringify({ main: mainLabel, sev: mainSev, triggered: triggered.map(t => t[1]) }),
    barIndex: idx
  };
}

/**
 * R03: 跌破 55 日线 — 收盘下穿 MA55，进入非多头区域，55 日线定大势
 */
function checkBreakMa55(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 56) return { triggered: false };
  const idx = kLines.length - 1;
  const ma55 = calculateMA(kLines, 55);
  if (!priceCrossedBelowWithin(kLines, ma55, idx, 2)) return { triggered: false };

  const today = kLines[idx];
  return {
    triggered: true,
    ruleId: 'R03',
    message: `⚠️ 跌破55日线：收盘 ${today.close} < MA55 ${ma55[idx].toFixed(2)}，进入非多头区域，不是当下好的选择（55日线定大势）`,
    extraData: JSON.stringify({ close: today.close, ma55: ma55[idx] }),
    barIndex: idx
  };
}

/**
 * R04: 5/13 金叉 — MA5 上穿 MA13
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
  const volConfirmed = avg5 > 0 && effectiveTodayVolume(kLines, quote) > avg5 * 1.2;

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
    ruleId: 'R04',
    message,
    extraData: JSON.stringify({ ma5: ma5[idx], ma13: ma13[idx], volConfirmed, aboveMa55 }),
    barIndex: idx
  };
}

/**
 * R05: 5/10 金叉 — MA5 上穿 MA10。短线波段启动，放量确认更可信。
 * 与 R04 5/13 金叉同时出现属多重确认（买入信号叠加确认，不互斥）。
 */
function checkMa5Cross10Golden(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 12) return { triggered: false };
  const idx = kLines.length - 1;
  const ma5 = calculateMA(kLines, 5);
  const ma10 = calculateMA(kLines, 10);
  if (!crossedAboveWithin(ma5, ma10, idx, 2)) return { triggered: false };

  const today = kLines[idx];
  const avg5 = calculateAvgVolume(kLines.slice(0, -1), 5);
  const volConfirmed = avg5 > 0 && effectiveTodayVolume(kLines, quote) > avg5 * 1.2;

  const message = volConfirmed
    ? `🟢 5日金叉10日：MA5 ${ma5[idx].toFixed(2)} > MA10 ${ma10[idx].toFixed(2)}，放量确认，短线启动`
    : `ℹ️ 5日金叉10日：MA5 ${ma5[idx].toFixed(2)} > MA10 ${ma10[idx].toFixed(2)}，缩量，需量能确认`;
  return {
    triggered: true,
    ruleId: 'R05',
    message,
    extraData: JSON.stringify({ ma5: ma5[idx], ma10: ma10[idx], volConfirmed }),
    barIndex: idx
  };
}

/**
 * R06: 止跌企稳 — 抛压释放(>10%) + 新低区域锤子线/十字星
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
  // 锤子线（底部承接）：下影≥实体×2 + 下影>2% + 上影<1%。与 R01 顶部"长下影见顶"靠位置上下文分流。
  const isHammer = shape.body > 0 && shape.lowerShadow >= shape.body * 2 && shape.lowerShadowPct > 2.0 && shape.upperShadowPct < 1.0;

  let sig = '';
  if (isHammer) sig = `锤子线（下影${shape.lowerShadowPct.toFixed(1)}%，实体${(shape.body / today.open * 100).toFixed(1)}%）`;
  else if (shape.isDoji) sig = '十字星';

  if (sig) {
    return {
      triggered: true,
      ruleId: 'R06',
      message: `🟢 止跌企稳：抛压已释放 ${(dropRange * 100).toFixed(0)}%，新低区域出现${sig}，关注低吸`,
      extraData: JSON.stringify({ dropRange, lowerShadowPct: shape.lowerShadowPct, isHammer }),
      barIndex: idx
    };
  }
  return { triggered: false };
}

/**
 * R07: RSI 超卖 — 仅保留 RSI(6)<20 超卖，并加趋势过滤：强下行趋势（MA20 下行 + 收盘破 MA20）
 * 中的超卖可靠性低（接飞刀），不报。底背离分支已移除，底部信号统一交给 R06 止跌企稳（右侧K线确认）。
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
      ruleId: 'R07',
      message: `🟢 RSI超卖：RSI(6)=${rsi6.toFixed(1)} < 20，进入超卖区（非强下行趋势），适合逢低布局`,
      extraData: JSON.stringify({ rsi6 }),
      barIndex: idx
    };
  }
  return { triggered: false };
}

/**
 * R08: 反包入场 — 回调后放量反包突破（放量为硬条件：等效全日量 > 昨日×1.2）
 */
function checkReboundEntry(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 20) return { triggered: false };
  const idx = kLines.length - 1;

  const recent15 = kLines.slice(-15);
  const today = kLines[idx];
  const prev1 = kLines[idx - 1];
  const change = calculateChangePercent(today.close, prev1.close);
  const volConfirmed = effectiveTodayVolume(kLines, quote) > prev1.volume * 1.2;

  const recentMin = Math.min(...recent15.map(k => k.low));
  const recentMaxBefore = Math.max(...recent15.slice(0, -1).map(k => k.high));
  const hasPullback = (recentMaxBefore - recentMin) / recentMaxBefore > 0.05;

  if (change >= 5.0 && hasPullback && today.close >= recentMaxBefore * 0.98 && volConfirmed) {
    return {
      triggered: true,
      ruleId: 'R08',
      message: `🟢 反包入场：大涨 ${change.toFixed(2)}%，放量反包，W型/C浪企稳突破`,
      extraData: JSON.stringify({ change, volConfirmed }),
      barIndex: idx
    };
  }
  return { triggered: false };
}

/**
 * R09: 黄金位反弹 — 回调至黄金位(38.2%-61.8%)放量反弹
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

  if (ratio >= 0.382 && ratio <= 0.618 && change > 3.0 && effectiveTodayVolume(kLines, quote) > prev1.volume * 1.2) {
    return {
      triggered: true,
      ruleId: 'R09',
      message: `🟢 黄金位反弹：回调至 ${(ratio * 100).toFixed(0)}% + 放量阳线 ${change.toFixed(1)}%`,
      extraData: JSON.stringify({ ratio, change, volConfirmed: true }),
      barIndex: idx
    };
  }
  return { triggered: false };
}

/**
 * R10: 箱体信号 — 突破(40日箱体上沿>3%+放量)优先；否则 吸筹(60日箱体+放量小阳)
 * 突破(40日箱体上沿>3%+放量)优先；否则 吸筹(60日箱体+放量小阳)
 */
function checkBoxSignal(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  if (kLines.length < 42) return { triggered: false };
  const idx = kLines.length - 1;
  const today = kLines[idx];
  const prev1 = kLines[idx - 1];
  const avgVol20 = calculateAvgVolume(kLines.slice(0, -1), 20);
  const effVol = effectiveTodayVolume(kLines, quote); // 盘中折算等效全日量

  // 箱体突破
  const { high: boxHigh40, range: range40 } = getBoxRange(kLines.slice(0, -1), 40);
  if (range40 <= 0.20) {
    const breakoutPct = (today.close - boxHigh40) / boxHigh40 * 100;
    if (breakoutPct >= 3.0 && avgVol20 > 0 && effVol >= avgVol20 * 1.2) {
      return {
        triggered: true,
        ruleId: 'R10',
        message: `🟢 箱体突破：40日箱体上沿${boxHigh40.toFixed(2)}，突破${breakoutPct.toFixed(1)}% + 放量确认`,
        extraData: JSON.stringify({ boxHigh: boxHigh40, breakoutPct, type: 'breakout', volConfirmed: true }),
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
      if (change >= 1.0 && change <= 4.0 && avgVol20 > 0 && effVol > avgVol20 * 1.3) {
        return {
          triggered: true,
          ruleId: 'R10',
          message: `🟢 箱体吸筹：放量小阳线 ${change.toFixed(2)}%，关注标的`,
          extraData: JSON.stringify({ change, type: 'accumulate', volConfirmed: true }),
          barIndex: idx
        };
      }
    }
  }
  return { triggered: false };
}

/**
 * R11: 均线多头排列 — MA5>MA13>MA55 且股价站上MA55，且多头排列刚刚形成
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

  // 放量确认：量比≥1.2 → 多头格局强势；缩量 → 弱势多头需确认
  const avg5 = calculateAvgVolume(kLines.slice(0, -1), 5);
  const volRatio = avg5 > 0 ? effectiveTodayVolume(kLines, quote) / avg5 : 0;
  const volConfirmed = volRatio >= 1.2;
  const message = volConfirmed
    ? `🟢 均线多头排列：MA5 ${ma5[idx].toFixed(2)} > MA13 ${ma13[idx].toFixed(2)} > MA55 ${ma55[idx].toFixed(2)}，放量确认，多头格局确立`
    : `ℹ️ 均线多头排列：MA5 ${ma5[idx].toFixed(2)} > MA13 ${ma13[idx].toFixed(2)} > MA55 ${ma55[idx].toFixed(2)}，但缩量，弱势多头需量能确认`;
  return {
    triggered: true,
    ruleId: 'R11',
    message,
    extraData: JSON.stringify({ ma5: ma5[idx], ma13: ma13[idx], ma55: ma55[idx], volConfirmed }),
    barIndex: idx
  };
}

/**
 * R12: 站稳五日线加仓 — 连续3日收盘站上MA5，且MA5上行、站稳刚刚形成
 * （站稳前一日在MA5之下，避免上行趋势中每日重复触发）。加仓信号。
 */
function checkHoldMa5(kLines: KLineData[], quote: RealtimeQuote | null, rule: AlertRule): RuleCheckResult {
  const holdDays = 3;
  if (kLines.length < 8) return { triggered: false };
  const idx = kLines.length - 1;
  const ma5 = calculateMA(kLines, 5);
  const today = kLines[idx];

  // 连续3日收盘站上MA5
  for (let i = 0; i < holdDays; i++) {
    if (!(ma5[idx - i] > 0 && kLines[idx - i].close > ma5[idx - i])) return { triggered: false };
  }
  // 站稳刚刚形成：站稳前一日收盘在MA5之下（否则上行趋势中会每日触发）
  if (!(ma5[idx - holdDays] > 0 && kLines[idx - holdDays].close <= ma5[idx - holdDays])) return { triggered: false };
  // MA5上行确认，过滤横盘假站稳
  if (!(ma5[idx] > ma5[idx - holdDays])) return { triggered: false };

  // 量价配合：温和放量(1.0~1.8)量价配合好；暴量(>1.8)注意赶顶/放量滞涨；缩量确认度一般
  const avg5 = calculateAvgVolume(kLines.slice(0, -1), 5);
  const volRatio = avg5 > 0 ? effectiveTodayVolume(kLines, quote) / avg5 : 0;
  const volConfirmed = volRatio >= 1.0 && volRatio <= 1.8;
  let message: string;
  if (volConfirmed) {
    message = `🟢 站稳五日线：连续3日收盘站上MA5（${ma5[idx].toFixed(2)}），MA5上行，温和放量量价配合好，可考虑加仓`;
  } else if (volRatio > 1.8) {
    message = `⚠️ 站稳五日线：连续3日收盘站上MA5（${ma5[idx].toFixed(2)}），MA5上行，但暴量，注意赶顶/放量滞涨，谨慎加仓`;
  } else {
    message = `ℹ️ 站稳五日线：连续3日收盘站上MA5（${ma5[idx].toFixed(2)}），MA5上行，但缩量，确认度一般`;
  }

  return {
    triggered: true,
    ruleId: 'R12',
    message,
    extraData: JSON.stringify({ ma5: ma5[idx], holdDays, volRatio, volConfirmed }),
    barIndex: idx
  };
}

// ==================== 筹码峰弱提醒（R13 买 / R14 卖，B级参考，不计入共振硬聚合） ====================

/**
 * R13 筹码低位密集（买入弱提醒）
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
      ruleId: 'R13',
      message: `🟡 筹码低位密集：90%集中度${chip.concentration90.toFixed(3)}，获利盘${(chip.profitRatio * 100).toFixed(0)}%，主峰${chip.dominantPeak.toFixed(2)}接近/低于现价，结构偏多（参考级）`,
      extraData: JSON.stringify({ concentration90: chip.concentration90, profitRatio: chip.profitRatio, dominantPeak: chip.dominantPeak, avgCost: chip.avgCost }),
    };
  }
  return { triggered: false };
}

/**
 * R14 筹码高位套牢（卖出弱提醒）
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
      ruleId: 'R14',
      message: `🟡 筹码高位套牢：获利盘仅${(chip.profitRatio * 100).toFixed(0)}%，主峰${chip.dominantPeak.toFixed(2)}高于现价，20日涨${ret20d.toFixed(0)}%后上方压力大（参考级）`,
      extraData: JSON.stringify({ profitRatio: chip.profitRatio, dominantPeak: chip.dominantPeak, ret20d }),
    };
  }
  return { triggered: false };
}

// ==================== 预警规则配置（14条） ====================

export const ALERT_RULES: AlertRule[] = [
  // -------- 卖出 / 风险（3条：2个阶梯 + R03） --------
  {
    id: 'R01',
    name: '见顶阶梯',
    description: '见顶/过热/量能出逃信号合并阶梯：对子顶/巨量见顶/第二波见顶/长上影/跳空衰竭/纺锤线/长下影见顶（弱提醒）/涨停封板/涨停炸板/巨量异动，按严重度择优只出一条预警',
    category: 'PATTERN' as any,
    level: 'CRITICAL' as any,
    suggestion: '见顶信号，适当减仓；对子顶/巨量见顶等强信号应更果断',
    isEnabled: true,
    thresholdValue: 1.20
  },
  {
    id: 'R02',
    name: '离场阶梯',
    description: '破位/离场信号合并阶梯：急跌/5/13死叉(破55日线才清仓)/5/10死叉/破趋势线+破MA60/有效跌破10日线/跌破5日线/破趋势线/跌破10日线待确认，按严重度择优只出一条预警',
    category: 'MOVING_AVG' as any,
    level: 'CRITICAL' as any,
    suggestion: '阶梯减仓控回撤：破5日线先减、有效破10日线大减、真死叉(破55日线)/急跌/破MA60清仓；10日线为卖出主线',
    isEnabled: true
  },
  {
    id: 'R03',
    name: '跌破55日线',
    description: '收盘跌破MA55进入非多头区域，55日线定大势',
    category: 'MOVING_AVG' as any,
    level: 'WARNING' as any,
    suggestion: '非多头区域不轻易做多，等待重新站上55日线',
    isEnabled: true
  },
  // -------- 买入 / 机会（9条） --------
  {
    id: 'R04',
    name: '5/13金叉',
    description: 'MA5上穿MA13；放量+站上55日线→强买(A级)，否则谨慎(B级)',
    category: 'OPPORTUNITY' as any,
    level: 'INFO' as any,
    suggestion: '金叉可考虑买点，缩量或未站上55日线时结合MACD确认',
    isEnabled: true
  },
  {
    id: 'R05',
    name: '5/10金叉',
    description: 'MA5上穿MA10；放量确认短线启动，与5/13金叉同时出现属多重确认',
    category: 'OPPORTUNITY' as any,
    level: 'INFO' as any,
    suggestion: '短线启动信号，放量确认后更可信；缩量需结合其他信号',
    isEnabled: true
  },
  {
    id: 'R06',
    name: '止跌企稳',
    description: '抛压释放(>10%)+新低区锤子线(下影≥实体×2+上影<1%)或十字星',
    category: 'OPPORTUNITY' as any,
    level: 'INFO' as any,
    suggestion: '经典锤子线企稳信号，结合量能确认低吸',
    isEnabled: true
  },
  {
    id: 'R07',
    name: 'RSI超卖',
    description: 'RSI(6)<20超卖，且非强下行趋势（MA20下行+破MA20时过滤，避免接飞刀）',
    category: 'RSI' as any,
    level: 'INFO' as any,
    suggestion: '超卖适合逢低布局，结合趋势确认',
    isEnabled: true
  },
  {
    id: 'R08',
    name: '反包入场',
    description: '回调后放量反包突破',
    category: 'OPPORTUNITY' as any,
    level: 'INFO' as any,
    suggestion: '企稳反包，考虑入场',
    isEnabled: true
  },
  {
    id: 'R09',
    name: '黄金位反弹',
    description: '回调至黄金位(38.2%-61.8%)放量反弹',
    category: 'OPPORTUNITY' as any,
    level: 'INFO' as any,
    suggestion: '黄金支撑反弹，入场机会',
    isEnabled: true
  },
  {
    id: 'R10',
    name: '箱体信号',
    description: '箱体突破(40日振幅<20%+突破>3%+放量)或箱体吸筹(60日箱体+放量小阳)，突破优先',
    category: 'OPPORTUNITY' as any,
    level: 'INFO' as any,
    suggestion: '箱体突破是趋势启动信号，可试探性建仓',
    isEnabled: true
  },
  {
    id: 'R11',
    name: '均线多头排列',
    description: 'MA5>MA13>MA55且股价站上MA55，且多头排列刚刚形成',
    category: 'MOVING_AVG' as any,
    level: 'INFO' as any,
    suggestion: '多头格局确立，可考虑顺势布局',
    isEnabled: true
  },
  {
    id: 'R12',
    name: '站稳五日线加仓',
    description: '连续3日收盘站上MA5且MA5上行，站稳刚刚形成（站稳前一日在MA5之下），加仓信号',
    category: 'OPPORTUNITY' as any,
    level: 'INFO' as any,
    suggestion: '反弹站稳五日线，强势确立可考虑加仓',
    isEnabled: true
  },
  // -------- 筹码峰弱提醒（2条，B级参考，不计入共振硬聚合） --------
  {
    id: 'R13',
    name: '筹码低位密集',
    description: '筹码90%集中度<0.18且获利盘>60%且主峰接近/低于现价，结构偏多（参考级）',
    category: 'PATTERN' as any,
    level: 'INFO' as any,
    suggestion: '筹码低位密集，主力成本区在下方，结合趋势与量能综合判断（参考级，不作为一票通过）',
    isEnabled: true
  },
  {
    id: 'R14',
    name: '筹码高位套牢',
    description: '获利盘<40%且主峰高于现价5%且20日涨幅>15%，上方套牢盘重（参考级）',
    category: 'PATTERN' as any,
    level: 'WARNING' as any,
    suggestion: '上方筹码峰压力大，追高需谨慎（参考级，不作为一票否决）',
    isEnabled: true
  }
];

/** sina 格式(sz002415/sh600664) → Tushare 格式(002415.SZ/600664.SH)；已 Tushare 格式原样返回 */
export function toTushareCode(c: string): string {
  const m = c.match(/^([a-z]{2})(\d{6})$/i);
  return m ? `${m[2]}.${m[1].toUpperCase()}` : c;
}

/** 当日全市场涨跌停价表（stk_limit，前端预取传入）：Tushare code → { up, down }。未传入/未命中回落规则推算 */
export type LimitPriceMap = Record<string, { up: number; down: number }>;

/**
 * 检查所有启用的规则
 * @param limitMap 可选：当日精确涨跌停价表（/api/stock-limit 预取），R01 涨停封板/炸板判定用
 * @param isETF 可选：标的为 ETF 时传 true。ETF 无打板/连板情绪生态（宽基几乎不可能涨停），
 *   且 R01 内部量比阈值按个股口径标定（跨境 T+0 品种量比 5x 是日常），故整体跳过 R01。
 *   P1 可回灌「对子顶/巨量见顶」子信号 + ETF 量比档（见 memory: etf-feature-notes）。
 *   R13/R14 筹码规则无需在此禁用——ETF 无 daily_bars 换手率，chip 恒为 null，规则内部自跳过。
 */
export function checkAllRules(
  kLines: KLineData[],
  quote: RealtimeQuote | null,
  enabledRules: AlertRule[] = ALERT_RULES.filter(r => r.isEnabled),
  chip?: ChipDistribution | null,
  limitMap?: LimitPriceMap | null,
  isETF = false
): RuleCheckResult[] {
  const results: RuleCheckResult[] = [];

  for (const rule of enabledRules) {
    if (isETF && rule.id === 'R01') continue;
    let result: RuleCheckResult;
    switch (rule.id) {
      case 'R01': result = checkTopPattern(kLines, quote, rule, limitMap); break;
      case 'R02': result = checkTieredExit(kLines, quote, rule); break;
      case 'R03': result = checkBreakMa55(kLines, quote, rule); break;
      case 'R04': result = checkMa5Cross13Golden(kLines, quote, rule); break;
      case 'R05': result = checkMa5Cross10Golden(kLines, quote, rule); break;
      case 'R06': result = checkBottomStabilize(kLines, quote, rule); break;
      case 'R07': result = checkRsiBottom(kLines, quote, rule); break;
      case 'R08': result = checkReboundEntry(kLines, quote, rule); break;
      case 'R09': result = checkGoldenRebound(kLines, quote, rule); break;
      case 'R10': result = checkBoxSignal(kLines, quote, rule); break;
      case 'R11': result = checkMaBullAlignment(kLines, quote, rule); break;
      case 'R12': result = checkHoldMa5(kLines, quote, rule); break;
      case 'R13': result = checkChipLowConcentrate(kLines, quote, rule, chip); break;
      case 'R14': result = checkChipHighTrap(kLines, quote, rule, chip); break;
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
  R02: { level: 'A', role: '风控专家' },
  R03: { level: 'B', role: '技术分析师' },
  R04: { level: 'A', role: '技术分析师' },
  R05: { level: 'B', role: '技术分析师' },
  R06: { level: 'A', role: '通用' },
  R07: { level: 'A', role: '技术分析师' },
  R08: { level: 'B', role: '技术分析师' },
  R09: { level: 'B', role: '技术分析师' },
  R10: { level: 'B', role: '技术分析师' },
  R11: { level: 'B', role: '技术分析师' },
  R12: { level: 'B', role: '技术分析师' },
  R13: { level: 'B', role: '结构参考' },
  R14: { level: 'B', role: '结构参考' },
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
 * 卖出/风险侧规则 ID（与 ALERT_RULES 分组同源：R01/R02/R03/R14）。
 * R14 筹码高位套牢归卖出侧。其余 ruleId 均为买入/机会侧。
 * 用于 UI 把同日多个买入信号聚合成"共振"展示。
 */
export const SELL_RULE_IDS = new Set(['R01', 'R02', 'R03', 'R14']);

/** 参考级弱提醒规则 ID（R13/R14）：从买入共振≥2 硬聚合计数剔除，仅作展示提示 */
export const REFERENCE_RULE_IDS = new Set(['R13', 'R14']);

/** 强卖出阈值：阶梯主信号 severity ≥ 3 才算强卖出（对子顶/巨量见顶/涨停炸板/死叉/急跌/有效跌破10日线…） */
const STRONG_SELL_SEV = 3;

/**
 * 是否强卖出信号 —— 预警页「整卡染绿 / 摘买入共振徽章」的门槛。
 * R01/R02 阶梯按主信号 severity 分级：≥3 强卖出；≤2 弱提醒（巨量异动/涨停封板/跌破5日线/站上55日线的5/13假死叉等）
 * 仅行内展示，不影响卡片方向——弱提醒不应对买入共振有一票否决权（有研新材 2026-08-10 案例：
 * 4 条买入共振被一条巨量异动整卡染绿、徽章被摘）。
 * R03 等单信号卖出规则恒强；旧记录 extraData 无 sev 字段 → 保守按强处理（与改动前行为一致）。
 */
export function isStrongSellAlert(ruleId?: string, extraData?: string | null): boolean {
  if (!ruleId || !SELL_RULE_IDS.has(ruleId) || REFERENCE_RULE_IDS.has(ruleId)) return false;
  if (ruleId === 'R01' || ruleId === 'R02') {
    try {
      const sev = JSON.parse(extraData ?? '{}')?.sev;
      if (typeof sev === 'number') return sev >= STRONG_SELL_SEV;
    } catch { /* 解析失败按旧记录处理 */ }
  }
  return true;
}

/**
 * 阶梯主信号 severity → 预警级别（排序/落库用）：sev≥4 CRITICAL、3 WARNING、≤2 INFO。
 * 非阶梯规则、或 extraData 无 sev 的旧数据，原样返回 fallback。
 */
export function severityAlertLevel(ruleId: string | undefined, extraData: string | null | undefined, fallback: AlertLevel): AlertLevel {
  if (ruleId !== 'R01' && ruleId !== 'R02') return fallback;
  try {
    const sev = JSON.parse(extraData ?? '{}')?.sev;
    if (typeof sev !== 'number') return fallback;
    if (sev >= 4) return AlertLevel.CRITICAL;
    if (sev >= STRONG_SELL_SEV) return AlertLevel.WARNING;
    return AlertLevel.INFO;
  } catch {
    return fallback;
  }
}

/** 判断 ruleId 是否为买入/机会侧（非卖出/风险侧） */
export function isBuyRule(ruleId?: string): boolean {
  if (!ruleId) return false;
  return !SELL_RULE_IDS.has(ruleId);
}

/**
 * 买入规则强度权重（预警页"买入共振强度档位"用）：A级=2，B级=1。
 * 卖出/参考级规则返回 0，不参与买入强度计分。
 */
export function buyRuleWeight(ruleId?: string): number {
  if (!ruleId) return 0;
  if (SELL_RULE_IDS.has(ruleId) || REFERENCE_RULE_IDS.has(ruleId)) return 0;
  return RULE_RELIABILITY[ruleId]?.level === 'A' ? 2 : 1;
}
