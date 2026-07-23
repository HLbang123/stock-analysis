/**
 * 技术指标计算库 — 提取自 TradingAgents-CN data_source_manager.py
 * 纯 TypeScript 实现，无外部依赖
 *
 * 本文件是全站技术指标的【单一事实源】：
 *   - calculateMA / calculateEMA / calcRSISeries / calcVolMA 为导出的序列计算器
 *   - calculateIndicators（快照，喂 AI prompt）派生自这些序列函数
 *   - services/alertRules.ts 也复用同一套序列函数，不再各自重算 MA/RSI/成交量
 *
 * "吃不吃盘中合成 bar" 由 splitKLines 在数据边界一次性决定：
 *   - RSI 用 completedBars（已完成日K，与同花顺对齐）
 *   - MA / MACD / 布林 / BIAS / VolMA 用 combinedBars（含盘中合成 bar，盘中实时跳动）
 */

import { KLineData, IndicatorResult } from '@/types';
import { splitKLines, combinedBars } from '@/lib/stock-helpers';

// ============ 基础序列计算函数（单一事实源，导出供 alertRules 复用） ============

/** 简单移动平均（序列，长度与输入一致，前 period-1 个为 NaN） */
export function calculateMA(values: number[], period: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      result.push(NaN);
    } else {
      const slice = values.slice(i - period + 1, i + 1);
      result.push(slice.reduce((s, v) => s + v, 0) / period);
    }
  }
  return result;
}

/** EMA — 等价于 Python pandas ewm(span=N, adjust=false) */
export function calculateEMA(values: number[], span: number): number[] {
  const result: number[] = new Array(values.length).fill(NaN);
  const multiplier = 2 / (span + 1);

  // 用 SMA 初始化第一个有效值
  const firstValid = values.findIndex(v => !isNaN(v));
  if (firstValid < 0) return result;

  const seedSlice = values.slice(firstValid, firstValid + span).filter(v => !isNaN(v));
  if (seedSlice.length === 0) return result;

  let ema = seedSlice.reduce((s, v) => s + v, 0) / seedSlice.length;
  result[firstValid + span - 1] = ema;

  for (let i = firstValid + span; i < values.length; i++) {
    if (!isNaN(values[i])) {
      ema = (values[i] - ema) * multiplier + ema;
    }
    result[i] = ema;
  }
  return result;
}

/**
 * RSI 序列（Wilder 原文：前 period 周期 SMA 初始化 + 后续 Wilder EMA 平滑）。
 * 返回长度与 closes 一致的数组；前 period 个为 NaN（数据不足）。
 * 与同花顺一致。调用方负责传入"已完成日K"的 closes（不含盘中合成 bar）。
 */
export function calcRSISeries(closes: number[], period: number): number[] {
  const result: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < period + 1) return result;

  const gains: number[] = new Array(closes.length - 1).fill(0);
  const losses: number[] = new Array(closes.length - 1).fill(0);
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains[i - 1] = diff > 0 ? diff : 0;
    losses[i - 1] = diff < 0 ? -diff : 0;
  }

  // Wilder 初始化：前 period 个周期的简单移动平均
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < period; i++) {
    avgGain += gains[i];
    avgLoss += losses[i];
  }
  avgGain /= period;
  avgLoss /= period;
  result[period] = rsiFromAvg(avgGain, avgLoss);

  // 后续用 Wilder 平滑：avg = (prevAvg*(N-1) + current) / N
  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    result[i + 1] = rsiFromAvg(avgGain, avgLoss);
  }
  return result;
}

function rsiFromAvg(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** 成交量均线（序列，前 period-1 个为 NaN） */
export function calcVolMA(volumes: number[], period: number): number[] {
  return calculateMA(volumes, period);
}

// ============ 主计算函数（快照，喂 AI prompt） ============

export function calculateIndicators(kLines: KLineData[]): IndicatorResult {
  // 显式分离已完成日K 与盘中合成 bar
  const series = splitKLines(kLines);
  const live = combinedBars(series); // MA/MACD/布林/BIAS/VolMA 用（含盘中）
  const closes = live.map(k => k.close);
  const volumes = live.map(k => k.volume);
  const completedCloses = series.completedBars.map(k => k.close);

  const last = closes.length - 1;
  const lastClose = closes[last];
  const lastVolume = volumes[last];

  // --- 均线（含盘中合成 bar，盘中实时跳动，与同花顺一致） ---
  const ma5Arr = calculateMA(closes, 5);
  const ma10Arr = calculateMA(closes, 10);
  const ma20Arr = calculateMA(closes, 20);
  const ma55Arr = calculateMA(closes, 55);
  const ma60Arr = calculateMA(closes, 60);

  // 乖离率专用均线
  const ma6Arr = calculateMA(closes, 6);
  const ma12Arr = calculateMA(closes, 12);
  const ma24Arr = calculateMA(closes, 24);

  // --- MACD（含盘中） ---
  const ema12 = calculateEMA(closes, 12);
  const ema26 = calculateEMA(closes, 26);
  const dif: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    dif.push(!isNaN(ema12[i]) && !isNaN(ema26[i]) ? ema12[i] - ema26[i] : NaN);
  }
  const validDif = dif.filter(v => !isNaN(v));
  const dea = calculateEMA(validDif, 9);
  let deaIdx = 0;
  const deaAligned: number[] = new Array(dif.length).fill(NaN);
  for (let i = 0; i < dif.length; i++) {
    if (!isNaN(dif[i]) && deaIdx < dea.length) {
      deaAligned[i] = dea[deaIdx++];
    }
  }

  // --- RSI（只用已完成日K，不含盘中合成 bar，与同花顺对齐） ---
  const rsi6Arr = calcRSISeries(completedCloses, 6);
  const rsi12Arr = calcRSISeries(completedCloses, 12);
  const rsi14Arr = calcRSISeries(completedCloses, 14);
  const rsi24Arr = calcRSISeries(completedCloses, 24);
  const completedLast = completedCloses.length - 1;

  // --- 布林带 (20日，含盘中) ---
  function calcBollinger(): { upper: number; mid: number; lower: number; position: number } {
    const n = 20;
    if (closes.length < n) return { upper: NaN, mid: NaN, lower: NaN, position: NaN };
    const slice = closes.slice(-n);
    const mid = slice.reduce((s, v) => s + v, 0) / n;
    const variance = slice.reduce((s, v) => s + (v - mid) ** 2, 0) / n;
    const std = Math.sqrt(variance);
    const upper = mid + 2 * std;
    const lower = mid - 2 * std;
    const position = lower !== upper ? ((lastClose - lower) / (upper - lower)) * 100 : 50;
    return { upper, mid, lower, position };
  }

  // --- 均量（含盘中） ---
  function calcVolMA(period: number): number {
    if (volumes.length < period) return NaN;
    const slice = volumes.slice(-period);
    return slice.reduce((s, v) => s + v, 0) / period;
  }

  return {
    ma5: ma5Arr[last],
    ma10: ma10Arr[last],
    ma20: ma20Arr[last],
    ma55: ma55Arr[last],
    ma60: ma60Arr[last],
    macd: {
      dif: dif[last],
      dea: deaAligned[last],
      histogram: !isNaN(dif[last]) && !isNaN(deaAligned[last])
        ? (dif[last] - deaAligned[last]) * 2
        : NaN,
    },
    rsi6: rsi6Arr[completedLast],
    rsi12: rsi12Arr[completedLast],
    rsi14: rsi14Arr[completedLast],
    rsi24: rsi24Arr[completedLast],
    bias6: ma6Arr[last] && !isNaN(ma6Arr[last]) ? ((lastClose - ma6Arr[last]) / ma6Arr[last]) * 100 : NaN,
    bias12: ma12Arr[last] && !isNaN(ma12Arr[last]) ? ((lastClose - ma12Arr[last]) / ma12Arr[last]) * 100 : NaN,
    bias24: ma24Arr[last] && !isNaN(ma24Arr[last]) ? ((lastClose - ma24Arr[last]) / ma24Arr[last]) * 100 : NaN,
    bollinger: calcBollinger(),
    volMa5: calcVolMA(5),
    volMa20: calcVolMA(20),
    lastClose,
    lastVolume,
  };
}

/**
 * 将指标结果格式化为注入 prompt 的结构化文本块
 */
export function formatIndicatorsForPrompt(result: IndicatorResult): string {
  const fmt = (v: number | undefined | null, decimals = 2): string => {
    if (v === undefined || v === null || isNaN(v)) return 'N/A';
    return v.toFixed(decimals);
  };

  const volFmt = (v: number): string => {
    if (isNaN(v)) return 'N/A';
    if (v >= 10000) return (v / 10000).toFixed(0) + '万手';
    return v.toFixed(0) + '手';
  };

  const macdDIF = result.macd?.dif;
  const macdDEA = result.macd?.dea;
  const macdHist = result.macd?.histogram;

  return `## 技术指标汇总
| 指标 | 数值 | 参考意义 |
|------|------|----------|
| 当前价 | ${fmt(result.lastClose)} | — |
| MA5 | ${fmt(result.ma5)} | 短期趋势，当前价${result.lastClose > result.ma5 ? '高于' : '低于'}MA5${result.lastClose > result.ma5 ? '偏多' : '偏空'} |
| MA10 | ${fmt(result.ma10)} | 短期趋势线 |
| MA20 | ${fmt(result.ma20)} | 中期趋势线 |
| MA55 | ${fmt(result.ma55)} | 大势分界（R05用，多头/非多头区域） |
| MA60 | ${fmt(result.ma60)} | 长期趋势线（牛熊分界） |
| MACD DIF | ${fmt(macdDIF)} | ${!isNaN(macdDIF) && !isNaN(macdDEA) ? (macdDIF! > macdDEA! ? 'DIF在DEA上方，多头' : 'DIF在DEA下方，空头') : ''} |
| MACD DEA | ${fmt(macdDEA)} | |
| MACD 柱 | ${fmt(macdHist)} | ${!isNaN(macdHist!) ? (macdHist! > 0 ? '正值=多头动能' : '负值=空头动能') : ''} |
| RSI(6) | ${fmt(result.rsi6)} | >80超买区，<20超卖区 |
| RSI(12) | ${fmt(result.rsi12)} | |
| RSI(14) | ${fmt(result.rsi14)} | >70超买区，<30超卖区 |
| RSI(24) | ${fmt(result.rsi24)} | |
| BIAS(6) | ${result.bias6 > 0 ? '+' : ''}${fmt(result.bias6)}% | 6日乖离率，>5%超买，<-5%超卖 |
| BIAS(12) | ${result.bias12 > 0 ? '+' : ''}${fmt(result.bias12)}% | 12日乖离率 |
| BIAS(24) | ${result.bias24 > 0 ? '+' : ''}${fmt(result.bias24)}% | 24日乖离率，>10%极度超买 |
| 布林上轨 | ${fmt(result.bollinger?.upper)} | 价格接近上轨=超买 |
| 布林中轨 | ${fmt(result.bollinger?.mid)} | 20日均线 |
| 布林下轨 | ${fmt(result.bollinger?.lower)} | 价格接近下轨=超卖 |
| 布林位置 | ${fmt(result.bollinger?.position)}% | 价格在布林带中的百分位（>80%高位，<20%低位） |
| 5日均量 | ${volFmt(result.volMa5)} | |
| 20日均量 | ${volFmt(result.volMa20)} | 当前量能${!isNaN(result.lastVolume) && !isNaN(result.volMa20) ? (result.lastVolume > result.volMa20 ? '大于' : '小于') + '20日均量' : ''} |`;
}
