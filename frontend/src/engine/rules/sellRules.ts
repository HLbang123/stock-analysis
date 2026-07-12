import type { Kline, Alert } from '../../types';
import { analyzeVolume } from '../indicators/volume';
import { calcMAs, lastValue } from '../indicators/ma';
import {
  detectCandleType,
  isBullish,
  isBearish,
  upperShadowRatio,
  bodyPercent,
  isInDowntrend,
  isInUptrend,
  isNearHigh,
} from '../patterns/candlestick';
import { detectDuiziDing, checkDuiziDingTriple } from '../patterns/duiziding';

let alertId = 0;
function alert(
  level: 2 | 3,
  rule: string,
  description: string,
  action: string
): Alert {
  return {
    id: `sell-${alertId++}`,
    level,
    category: 'sell',
    rule,
    description,
    action,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Check ALL sell/exit rules from the document against current K-line data.
 */
export function checkSellRules(klines: Kline[]): Alert[] {
  if (klines.length < 10) return [];
  const alerts: Alert[] = [];

  const vol = analyzeVolume(klines);
  const closes = klines.map(k => k.close);
  const mas = calcMAs(closes, [5, 10, 20]);
  const ma5Vals = mas.get(5)!;
  const ma5 = lastValue(ma5Vals);
  const ma20 = lastValue(mas.get(20)!);
  const lastClose = closes[closes.length - 1];
  const lastKline = klines[klines.length - 1];
  const prevKline = klines[klines.length - 2];

  // ====== Level 3: 清仓离场 ======

  // Rule: 放量跌破5日线 → 全部清仓
  if (ma5 !== null && lastClose < ma5 && vol.lastVol > vol.avgVol5 * 1.0) {
    alerts.push(alert(
      3,
      '放量跌破5日线',
      `收盘价 ${lastClose.toFixed(2)} 跌破 MA5 ${ma5.toFixed(2)}，成交量 ${vol.volRatio5.toFixed(1)}x`,
      '全部清仓离场'
    ));
  }

  // Rule: 放量跌破趋势线 (without user-drawn trendline, use MA20 as proxy)
  if (ma20 !== null && lastClose < ma20 && vol.isHighVolume) {
    alerts.push(alert(
      3,
      '放量跌破趋势线(MA20)',
      `收盘价 ${lastClose.toFixed(2)} 跌破 MA20 ${ma20.toFixed(2)}，放量 ${vol.volRatio5.toFixed(1)}x`,
      '全部清仓离场'
    ));
  }

  // Rule: 突发利空砸盘（当日跌幅 > 7%）
  if (prevKline) {
    const dayChange = (lastClose - prevKline.close) / prevKline.close;
    if (dayChange < -0.07) {
      alerts.push(alert(
        3,
        '突发暴跌（疑似利空）',
        `当日跌幅 ${(dayChange * 100).toFixed(1)}%，疑似利空砸盘`,
        '先抛再说，切忌抱有幻想'
      ));
    }
  }

  // Rule: 第二波量见顶 — 需要跨周期数据，这里标记为信息级
  if (vol.maxVolYear > 0 && vol.lastVol >= vol.maxVolYear * 0.95) {
    alerts.push({
      id: `info-${alertId++}`,
      level: 2,
      category: 'sell',
      rule: '接近年内最大量（第二波见顶参考）',
      description: `当前量 ${vol.lastVol} 接近一年最大量 ${vol.maxVolYear}（比率 ${(vol.lastVol/vol.maxVolYear*100).toFixed(0)}%）`,
      action: '若为第二波行情，达到第一波高潮量则离场',
      timestamp: new Date().toISOString(),
    });
  }

  // ====== Level 2: 减仓一半 ======

  // Rule: 放巨量不破5日线/趋势线 → 减仓一半
  if (vol.isHighVolume && ma5 !== null && lastClose >= ma5) {
    alerts.push(alert(
      2,
      '放巨量（止盈信号）',
      `量能 ${vol.volRatio5.toFixed(1)}x（前5日均量），MA5 ${ma5.toFixed(2)} 未破`,
      '减仓 1/3~1/2，锁定利润'
    ));
  }

  // Rule: 缩量跌破5日线 → 减仓一半
  if (ma5 !== null && lastClose < ma5 && !vol.isHighVolume) {
    alerts.push(alert(
      2,
      '缩量跌破5日线',
      `收盘价 ${lastClose.toFixed(2)} 跌破 MA5 ${ma5.toFixed(2)}，但缩量（${vol.volRatio5.toFixed(1)}x）`,
      '减仓一半，观察一两天能否企稳'
    ));
  }

  // Rule: 缩量跌破趋势线(MA20) → 减仓一半
  if (ma20 !== null && lastClose < ma20 && !vol.isHighVolume) {
    alerts.push(alert(
      2,
      '缩量破位趋势线(MA20)',
      `收盘价 ${lastClose.toFixed(2)} 跌破 MA20 ${ma20.toFixed(2)}，缩量`,
      '减仓一半'
    ));
  }

  // ====== Level 2: 减仓 1/3~1/2 ======

  // Rule: 长上影线出货信号
  const candleType = detectCandleType(lastKline);
  const upperShadow = lastKline.high - Math.max(lastKline.open, lastKline.close);
  const body = Math.abs(lastKline.close - lastKline.open);
  const hasLongUpper = body > 0 && upperShadow > body * 2;

  if (hasLongUpper && isNearHigh(klines)) {
    alerts.push(alert(
      2,
      '长上影线出货信号',
      `上影线长度 ${upperShadow.toFixed(2)}，实体 ${body.toFixed(2)}，处于相对高位`,
      '减仓 1/3~1/2，急拉缓跌是出货痕迹'
    ));
  }

  // Rule: 长上影线 + 放巨量（加强信号）
  if (hasLongUpper && vol.isHighVolume) {
    alerts.push(alert(
      2,
      '长上影线 + 放巨量',
      `上影线/实体比 ${(upperShadow/body).toFixed(1)}x，量能 ${vol.volRatio5.toFixed(1)}x`,
      '强烈的止盈信号，减仓 1/3~1/2'
    ));
  }

  // Rule: 对子顶三合一
  const duiziTriple = checkDuiziDingTriple(klines);
  if (duiziTriple.triggered) {
    alerts.push(alert(
      3,
      '对子顶三合一（见顶信号）',
      duiziTriple.description || '对子顶 + 长上影线 + 放巨量',
      '离场规避风险'
    ));
  } else if (duiziTriple.duizi.found) {
    alerts.push({
      id: `info-${alertId++}`,
      level: 0,
      category: 'info',
      rule: '对子顶',
      description: duiziTriple.duizi.description || '检测到对子顶',
      action: '关注是否叠加长上影线和放量',
      timestamp: new Date().toISOString(),
    });
  }

  // Rule: 横盘滞涨
  const recent5 = klines.slice(-5);
  const totalChange5 = Math.abs((recent5[recent5.length - 1].close - recent5[0].close) / recent5[0].close);
  if (totalChange5 < 0.02 && isNearHigh(klines, 20)) {
    alerts.push(alert(
      2,
      '横盘滞涨',
      `近5日波动仅 ${(totalChange5 * 100).toFixed(1)}%，处于高位`,
      '观望，不要轻举妄动，防止利润回吐'
    ));
  }

  // Rule: 第二波止盈（逢涨停/大涨出一些）— 当日涨幅>9%
  if (prevKline) {
    const dayGain = (lastClose - prevKline.close) / prevKline.close;
    if (dayGain > 0.09) {
      alerts.push(alert(
        2,
        '涨停/大涨止盈',
        `当日涨幅 ${(dayGain * 100).toFixed(1)}%`,
        '第二波行情逢涨停出一些，没有利润垫应谨慎'
      ));
    }
  }

  return alerts;
}
