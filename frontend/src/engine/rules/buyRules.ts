import type { Kline, Alert } from '../../types';
import { calcMAs, lastValue } from '../indicators/ma';
import { calcMACD, findMACDCross } from '../indicators/macd';
import { calcRSI } from '../indicators/rsi';
import { analyzeVolume } from '../indicators/volume';
import {
  detectCandleType,
  isStrongBullish,
  isInDowntrend,
} from '../patterns/candlestick';
import { detectWave2, detectWPattern } from '../patterns/wave2';
import { detectBoxRange, checkBoxBreakout } from '../patterns/boxRange';
import { detectBottomDivergence } from '../patterns/divergence';

let alertId = 0;
function alert(
  level: 0 | 1,
  rule: string,
  description: string,
  action: string
): Alert {
  return {
    id: `buy-${alertId++}`,
    level,
    category: 'buy',
    rule,
    description,
    action,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Check ALL buy/watch rules from the document.
 */
export function checkBuyRules(klines: Kline[]): Alert[] {
  if (klines.length < 30) return [];
  const alerts: Alert[] = [];

  const closes = klines.map(k => k.close);
  const mas = calcMAs(closes, [5, 10, 20]);
  const ma5 = lastValue(mas.get(5)!);
  const ma20 = lastValue(mas.get(20)!);
  const vol = analyzeVolume(klines);
  const lastKline = klines[klines.length - 1];

  // ====== Level 1: 入场信号（绿色） ======

  // Rule: 第二波反包阳线 ★ CORE
  const wave2 = detectWave2(klines);
  if (wave2.found && wave2.phase === 'breakout') {
    alerts.push(alert(
      1,
      '第二波反包阳线 ⭐',
      wave2.description || '上涨→回调→筑底→反包',
      '可考虑入场，找回调企稳点介入'
    ));
  }

  // Rule: W型/ABC浪完成
  const wPattern = detectWPattern(klines);
  if (wPattern.found) {
    alerts.push(alert(
      1,
      'W型（ABC浪）筑底完成',
      wPattern.description || 'W型调整完成',
      'C浪企稳后的反包阳线是入场点'
    ));
  }

  // Rule: 趋势线支撑企稳 (MA20 as trendline proxy)
  const candleType = detectCandleType(lastKline);
  const isStopSignal = candleType === 'doji' || candleType === 'hammer' || candleType === 'longLowerShadow';
  if (ma20 !== null && isInDowntrend(klines, 10)) {
    const closeAboveMA20 = lastKline.close > ma20;
    const nearMA20 = Math.abs(lastKline.close - ma20) / ma20 < 0.03;

    if (nearMA20 && isStopSignal) {
      alerts.push(alert(
        1,
        '趋势线(MA20)支撑企稳',
        `回调至MA20(${ma20.toFixed(2)})附近出现${candleType === 'doji' ? '十字星' : '止跌信号'}`,
        '可考虑分批低吸'
      ));
    }
  }

  // Rule: 箱体突破
  const box = detectBoxRange(klines, 15);
  if (box && checkBoxBreakout(klines, box)) {
    alerts.push(alert(
      1,
      '箱体突破',
      `突破震荡箱体上沿 ${box.top.toFixed(2)}（箱体已运行${box.days}天），放量确认`,
      '可考虑入场'
    ));
  }

  // Rule: 放量吃货小阳线（连续碎步小阳 + 温和放量）
  const recent5 = klines.slice(-5);
  let smallBullCount = 0;
  for (const k of recent5) {
    const bodyPct = Math.abs(k.close - k.open) / k.open * 100;
    if (k.close > k.open && bodyPct < 3 && bodyPct > 0.3) {
      smallBullCount++;
    }
  }
  if (smallBullCount >= 3 && vol.volRatio5 > 0.8 && vol.volRatio5 < 1.5) {
    alerts.push({
      id: `buy-${alertId++}`,
      level: 0,
      category: 'buy',
      rule: '连续小阳线放量吃货',
      description: `近5日${smallBullCount}根碎步小阳线，量能温和(${vol.volRatio5.toFixed(1)}x)`,
      action: '关注，可能是顶着抛压吸筹',
      timestamp: new Date().toISOString(),
    });
  }

  // Rule: 30分钟/日线底背离
  const divergence = detectBottomDivergence(klines);
  if (divergence.found) {
    alerts.push(alert(
      1,
      '底背离信号',
      divergence.description || '价格新低但指标不新低',
      '资金抄底迹象，可关注企稳后入场'
    ));
  }

  // ====== Level 0: 关注信号（蓝色） ======

  // Rule: 十字星企稳
  if (candleType === 'doji' && isInDowntrend(klines, 5)) {
    alerts.push(alert(
      0,
      '下跌中出现十字星',
      `${lastKline.date} 出现十字星，可能企稳`,
      '观察后续走势确认'
    ));
  }

  // Rule: 长下影线止跌
  if (candleType === 'longLowerShadow' && isInDowntrend(klines, 5)) {
    alerts.push(alert(
      0,
      '长下影线止跌信号',
      `${lastKline.date} 出现长下影线，在下跌后`,
      '关注，可能的止跌信号'
    ));
  }

  // Rule: 回调到黄金分割位
  // Find the most recent significant swing
  if (klines.length > 40) {
    const recent60 = klines.slice(-60);
    const swingHigh = Math.max(...recent60.map(k => k.high));
    const swingLow = Math.min(...recent60.map(k => k.low));
    const range = swingHigh - swingLow;
    if (range > 0) {
      const fib382 = swingLow + range * 0.618; // 0.618 retracement
      const fib500 = swingLow + range * 0.5;
      const fib618 = swingLow + range * 0.382;

      const lastClose = klines[klines.length - 1].close;
      if (Math.abs(lastClose - fib382) / fib382 < 0.02 ||
          Math.abs(lastClose - fib500) / fib500 < 0.02 ||
          Math.abs(lastClose - fib618) / fib618 < 0.02) {
        let level = '';
        if (Math.abs(lastClose - fib382) / fib382 < 0.02) level = '38.2%';
        else if (Math.abs(lastClose - fib500) / fib500 < 0.02) level = '50%';
        else level = '61.8%';

        alerts.push(alert(
          0,
          `回调至黄金分割${level}位`,
          `当前价 ${lastClose.toFixed(2)} 回调至${level}位置`,
          '观察是否企稳，反弹位置居中较理想'
        ));
      }
    }
  }

  // Rule: 第二波筑底中（等待信号）
  if (wave2.phase === 'base' && !wave2.found) {
    alerts.push({
      id: `buy-${alertId++}`,
      level: 0,
      category: 'buy',
      rule: '第二波筑底中',
      description: wave2.description || '等待反包阳线确认',
      action: '静候、观察、准备出击',
      timestamp: new Date().toISOString(),
    });
  }

  return alerts;
}
