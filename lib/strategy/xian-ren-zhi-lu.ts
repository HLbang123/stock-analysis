/**
 * 仙人指路 策略引擎（纯逻辑）
 * 规则见 docs/short-term-strategies.md 策略五。
 *
 * 口径（档2 · 大样本版，2026-09 回测定稿）：
 *   T0 试盘日：长上影（≥实体1.2倍、上影≥1.5%）、实体≤2%、收红0~5%、
 *             量比≥1.2、下影≤1%、振幅≤5%、收盘位≤0.45、60日涨幅≤30%、最低不破昨收。
 *   T1 确认日：现价反包 T0 上影 ≥40%、现价收位≥70%（扫描时点现价视作收盘价）、确认日高开≤1%。
 *   买点 = T1 确认日收盘（尾盘）；退出口径 = 次日（T2）冲高卖，不格局。
 */

export interface XianRenBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  preClose?: number | null;
  turnoverRate?: number | null;
}

export interface XianRenConfig {
  shadowRatioMin: number;     // 上影 / 实体
  upperShadowPctMin: number;  // 上影幅度 %
  bodyAbsPctMax: number;      // 实体幅度 %
  changePctMin: number;       // 试盘日收盘 vs 昨收 下限 %
  changePctMax: number;       // 上限 %
  volBaseDays: number;        // 量比基数（前 N 日）
  volRatioMin: number;        // 量比下限
  lowerShadowPctMax: number;  // 下影幅度 %
  amplitudePctMax: number;    // 振幅 %
  closePosMax: number;        // 收盘在当日振幅中的位置上限
  gain60Max: number;          // 60 日涨幅上限 %
  requireLowAbovePrev: boolean; // 最低价不破昨收
  confPctMin: number;         // 确认日反包上影比例下限
  confClosePosMin: number;    // 确认日收盘位下限（扫描时点现价视作收盘价计算）
  confOpenGapMax: number;     // 确认日高开上限 %
}

export const DEFAULT_XIANREN_CONFIG: XianRenConfig = {
  shadowRatioMin: 1.2,
  upperShadowPctMin: 1.5,
  bodyAbsPctMax: 2.0,
  changePctMin: 0,
  changePctMax: 5.0,
  volBaseDays: 5,
  volRatioMin: 1.2,
  lowerShadowPctMax: 1.0,
  amplitudePctMax: 5.0,
  closePosMax: 0.45,
  gain60Max: 30.0,
  requireLowAbovePrev: true,
  confPctMin: 0.4,
  confClosePosMin: 0.7,
  confOpenGapMax: 1.0,
};

export interface XianRenSignal {
  matched: boolean;
  t0Index: number; // 试盘日
  t1Index: number; // 确认日（买点）
  reason: string;
  failedChecks: string[];
  entryPrice: number;
  entryDate: string;
  metrics: {
    t0Date: string;
    upperShadowPct: number | null;
    bodyAbsPct: number | null;
    changePct: number | null;
    volRatio: number | null;
    amplitudePct: number | null;
    gain60: number | null;
    confPct: number | null;      // 反包上影比例（>100% 表示收上试盘日最高）
    confDayGain: number | null;  // 确认日涨幅 %
    confClosePos: number | null;
    confOpenGap: number | null;
  };
}

function round(n: number, d = 2): number {
  const p = Math.pow(10, d);
  return Math.round(n * p) / p;
}

function prevCloseOf(bars: XianRenBar[], i: number): number | null {
  const b = bars[i];
  if (b.preClose != null && b.preClose > 0) return b.preClose;
  return i > 0 ? bars[i - 1].close : null;
}

/**
 * 判定 confirmIdx 是否构成「仙人指路」确认日（其前一日为试盘日）。
 * 信号只在确认日收盘后成立：confirmIdx = T1，T0 = confirmIdx - 1。
 */
export function detectXianRenAt(
  bars: XianRenBar[],
  confirmIdx: number,
  config: Partial<XianRenConfig> = {}
): XianRenSignal {
  const cfg = { ...DEFAULT_XIANREN_CONFIG, ...config };
  const empty = (reason: string, fail: string[]): XianRenSignal => ({
    matched: false,
    t0Index: confirmIdx - 1,
    t1Index: confirmIdx,
    reason,
    failedChecks: fail,
    entryPrice: 0,
    entryDate: '',
    metrics: {
      t0Date: '', upperShadowPct: null, bodyAbsPct: null, changePct: null,
      volRatio: null, amplitudePct: null, gain60: null,
      confPct: null, confDayGain: null, confClosePos: null, confOpenGap: null,
    },
  });

  const t0Idx = confirmIdx - 1;
  if (confirmIdx < 1 || confirmIdx >= bars.length) return empty('数据不足', ['data_insufficient']);
  if (t0Idx < 60) return empty('数据不足', ['data_insufficient']); // 需 60 日历史算涨幅

  const t0 = bars[t0Idx];
  const t1 = bars[confirmIdx];
  const prevClose = prevCloseOf(bars, t0Idx);
  if (!prevClose || prevClose <= 0) return empty('数据不足', ['data_insufficient']);
  if (!(t0.open > 0)) return empty('数据不足', ['data_insufficient']);

  const fail: string[] = [];

  // ---- T0 试盘日 ----
  const body = t0.close - t0.open;
  const bodyAbs = Math.abs(body);
  const bodyAbsPct = (bodyAbs / t0.open) * 100;
  const upperShadow = t0.high - Math.max(t0.open, t0.close);
  const upperShadowPct = (upperShadow / t0.open) * 100;
  const lowerShadow = Math.min(t0.open, t0.close) - t0.low;
  const lowerShadowPct = (lowerShadow / t0.open) * 100;
  const shadowRatio = bodyAbs > 0.01 ? upperShadow / bodyAbs : (upperShadow > 0 ? 999 : 0);
  const changePct = ((t0.close - prevClose) / prevClose) * 100;
  const amplitudePct = ((t0.high - t0.low) / prevClose) * 100;
  const closePos = t0.high > t0.low ? (t0.close - t0.low) / (t0.high - t0.low) : 0.5;

  if (shadowRatio < cfg.shadowRatioMin) fail.push('shadow_ratio_low');
  if (upperShadowPct < cfg.upperShadowPctMin) fail.push('upper_shadow_short');
  if (bodyAbsPct > cfg.bodyAbsPctMax) fail.push('body_too_large');
  if (changePct < cfg.changePctMin) fail.push('not_red');
  if (changePct > cfg.changePctMax) fail.push('gain_too_large');
  if (lowerShadowPct > cfg.lowerShadowPctMax) fail.push('lower_shadow_too_long');
  if (amplitudePct > cfg.amplitudePctMax) fail.push('amplitude_too_large');
  if (closePos > cfg.closePosMax) fail.push('close_too_high');
  if (cfg.requireLowAbovePrev && t0.low < prevClose) fail.push('low_below_prev_close');

  let volSum = 0, volCnt = 0;
  for (let j = t0Idx - cfg.volBaseDays; j < t0Idx; j++) {
    if (j >= 0) { volSum += bars[j].volume; volCnt++; }
  }
  const volRatio = volCnt > 0 ? t0.volume / (volSum / volCnt) : 0;
  if (volRatio < cfg.volRatioMin) fail.push('volume_too_low');

  const gain60 = ((prevClose / bars[t0Idx - 60].close) - 1) * 100;
  if (gain60 > cfg.gain60Max) fail.push('gain60_too_high');

  // ---- T1 确认日 ----
  const confPct = upperShadow > 0 ? (t1.close - t0.close) / upperShadow : 0;
  const confDayGain = ((t1.close - t0.close) / t0.close) * 100;
  const confClosePos = t1.high > t1.low ? (t1.close - t1.low) / (t1.high - t1.low) : 0.5;
  const confOpenGap = ((t1.open - t0.close) / t0.close) * 100;

  if (confPct < cfg.confPctMin) fail.push('confirm_not_cover_shadow');
  if (confClosePos < cfg.confClosePosMin) fail.push('confirm_close_too_low');
  if (confOpenGap > cfg.confOpenGapMax) fail.push('confirm_gap_too_high');

  const matched = fail.length === 0;
  return {
    matched,
    t0Index: t0Idx,
    t1Index: confirmIdx,
    reason: matched ? '仙人指路形态符合' : fail[0],
    failedChecks: fail,
    entryPrice: matched ? round(t1.close) : 0,
    entryDate: matched ? t1.date : '',
    metrics: {
      t0Date: t0.date,
      upperShadowPct: round(upperShadowPct),
      bodyAbsPct: round(bodyAbsPct),
      changePct: round(changePct),
      volRatio: round(volRatio),
      amplitudePct: round(amplitudePct),
      gain60: round(gain60),
      confPct: round(confPct * 100),
      confDayGain: round(confDayGain),
      confClosePos: round(confClosePos, 2),
      confOpenGap: round(confOpenGap),
    },
  };
}
