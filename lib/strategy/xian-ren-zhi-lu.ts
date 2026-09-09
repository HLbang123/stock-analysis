/**
 * 仙人指路 策略引擎（纯逻辑）
 * 规则见 docs/short-term-strategies.md 策略五。
 *
 * 口径（档2 · 大样本版，2026-09 回测定稿）：
 *   T0 试盘日：长上影（≥实体1.2倍、上影≥1.5%）、实体≤2%、收红0~5%、
 *             量比无下限、下影≤1%、振幅≤5%、收盘位≤0.45、60日涨幅≤30%。
 *   T1 确认日：现价反包 T0 上影 ≥40%、现价收位≥70%（扫描时点现价视作收盘价）、确认日高开≤1%、
 *             确认日缩量（量比 ≤1.0）。
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
  confClosePosMin: number;    // 确认日收盘位下限（扫描时点现价视作收盘价计算）。
                              // 2026-09-11 由 0.7 降到 0.5 —— 见 DEFAULT 里的实测依据。
  confOpenGapMax: number;     // 确认日高开上限 %。2026-09-11 由 1.0 放宽到 5.0（近乎不拦）——
                              // 该门槛方向是反的，见 DEFAULT 里的实测依据。
  confVolRatioMax: number;    // 确认日量比参考线（T1 量 / 前5日均量）。2026-09-10 起**不再作硬门槛**，
                              // 也**不再是打分阈值**：打分层已改用 1.5 / 2.5 两个断点，且方向由
                              // 「缩量加分」翻转为「放量加分」（见 services/short-term-strategies/score.ts
                              // 顶部口径切换说明）。此字段现仅作回测脚本的对照基线保留。
}

export const DEFAULT_XIANREN_CONFIG: XianRenConfig = {
  shadowRatioMin: 1.2,
  upperShadowPctMin: 1.5,
  bodyAbsPctMax: 2.0,
  changePctMin: 0,
  changePctMax: 5.0,
  volBaseDays: 5,
  volRatioMin: 0, // 2026-09 剔924重测：1.2→0.8→0，删除量比门槛后信号+36%、T+1冲高胜率不降
  lowerShadowPctMax: 1.0,
  amplitudePctMax: 5.0,
  closePosMax: 0.45,
  gain60Max: 30.0,
  requireLowAbovePrev: false, // 2026-09 剔924重测：该门槛无效，删除后信号量翻倍、胜率微降1pp
  confPctMin: 0.4,
  // 2026-09-11 由 0.7 降到 0.5：五年剔924 超集实测（放宽两条门槛取 27,476 条，事后按实际值分组）——
  // 被 0.7 拒掉的 6.41 只/日，各项指标与入选组**持平**：T+1最高均值 2.000 vs 2.022、区间最高 3.697 vs 3.679、
  // P(区间≥2%) 57.3 vs 57.7，且 5 年逐年 0.3~0.7 与 0.7~0.95 无差（2025 年被拒组反而更好 2.148 vs 1.919）。
  // 真正有区分度的是 0.95~1.0（T+1最高 5/5 年最优），而**打分表已给该档 +12 分**——门槛与打分重复且无筛选力，
  // 故降为格式性下限，把"收在当日最高附近"交给打分层排序（与撤缩量门槛同一套处理逻辑）。
  confClosePosMin: 0.5,
  // 2026-09-11 由 1.0 放宽到 5.0（近乎不拦）：**该门槛方向是反的**。同批实测中被它拒掉的 1.45 只/日全面更好——
  // T+1最高均值 2.456 vs 入选 2.022（+21%）、区间最高 4.549 vs 3.679（+24%）、P(区间≥2%) 63.1% vs 57.7%、
  // T+3收盘 +0.544% vs +0.120%（4.5 倍）、盈亏比 1.42 vs 1.21、新打分均值 58.2 vs 51.7。
  // 逐年 5/5 一致：高开 >2.5% 组每年最好（3.32~3.99），1.0~2.5 组也 5/5 优于 0~1.0 组。
  // 端到端：撤掉后候选 16.2→17.6 只/日，而每日 Top1/Top3/Top5 的 T+1冲高均值**全部变好**（2.990→3.136）。
  // 原意是"别追高"，但实测追高更强，故撤销。
  confOpenGapMax: 5.0,
  confVolRatioMax: 1.0, // 参考线（不再作硬门槛、也不再作打分阈值）：2026-09-10 改判——作为硬门槛时
                        // 胜率 87.6%→89.9% 虽显著，但砍掉 59% 机会、被砍半赔率更大（冲高均值 2.10%
                        // vs 1.90%）、日总期望持平，故撤门槛。同日晚些时候打分口径从「冲高胜率」切到
                        // 「冲高幅度」后，该维度方向由缩量翻转为放量（>=2.5 才是最优档）。
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
    confVolRatio: number | null; // 确认日量比（T1 量 / 前5日均量）
  };
}

function round(n: number, d = 2): number {
  const p = Math.pow(10, d);
  return Math.round(n * p) / p;
}

/** MACD 象限：金叉(g)/死叉(d) × DIF 在零轴上(0)/下(1)；'na' = 历史不足 */
export type MacdQuad = 'g0' | 'd0' | 'g1' | 'd1' | 'na';

function emaSeries(values: number[], period: number): number[] {
  const out: number[] = [];
  const k = 2 / (period + 1);
  let prev = values[0] ?? 0;
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

/**
 * 试盘日（T0）的 MACD 象限。
 *
 * 2026-09 剔924五年复检（n=7217）：**零轴下方金叉（g1 = DIF<0 且 DIF>DEA）**是唯一
 * 在控制 gain60 与试盘日涨幅后仍存活的形态外因子——边际 +3.68pp，控制两层后 RE +2.47pp
 * （全样本 z 3.02）；在 hitCount=0 的 76% 主体里 RE +2.15pp（z 2.50）；五年逐年全为正。
 * 它抓的是「中期弱 + 短期刚转强」的**拐点**，与 gain60 的「位置低」不是同一信息。
 * 注意：外部资料常推荐「金叉 + DIF 零轴上方」，而该象限在本样本里是最差的（88.79%）。
 *
 * 需要至少 35 根历史（EMA26 稳定 + DEA 9）；不足时返回 'na'。
 */
export function computeMacdQuadAt(bars: XianRenBar[], idx: number): { dif: number; dea: number; quad: MacdQuad } {
  const MIN_BARS = 35;
  if (idx < MIN_BARS - 1 || idx >= bars.length) return { dif: 0, dea: 0, quad: 'na' };
  const closes: number[] = [];
  for (let i = 0; i <= idx; i++) closes.push(bars[i].close);
  const e12 = emaSeries(closes, 12);
  const e26 = emaSeries(closes, 26);
  const dif: number[] = closes.map((_, i) => e12[i] - e26[i]);
  const dea = emaSeries(dif, 9);
  const d = dif[idx], e = dea[idx];
  if (!Number.isFinite(d) || !Number.isFinite(e)) return { dif: 0, dea: 0, quad: 'na' };
  const quad: MacdQuad = d > e ? (d > 0 ? 'g0' : 'g1') : (d > 0 ? 'd0' : 'd1');
  return { dif: d, dea: e, quad };
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
      confPct: null, confDayGain: null, confClosePos: null, confOpenGap: null, confVolRatio: null,
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

  // 确认日量比：T1 量 / 前5日均量（T0 及往前 4 日）。缩量反包更优（2026-09 五年剔924重测）。
  let confVolSum = 0, confVolCnt = 0;
  for (let j = t0Idx - 4; j <= t0Idx; j++) {
    if (j >= 0) { confVolSum += bars[j].volume; confVolCnt++; }
  }
  const confVolRatio = confVolCnt > 0 ? t1.volume / (confVolSum / confVolCnt) : 0;

  if (confPct < cfg.confPctMin) fail.push('confirm_not_cover_shadow');
  if (confClosePos < cfg.confClosePosMin) fail.push('confirm_close_too_low');
  if (confOpenGap > cfg.confOpenGapMax) fail.push('confirm_gap_too_high');
  // 【2026-09-10 已撤硬门槛】原先此处按 cfg.confVolRatioMax 直接判失败（确认日缩量）。
  // 五年剔924全量对照：该门槛把日均可交易从 15.28 只砍到 6.29 只（-59%），胜率 +3.9pp 虽显著(z=7.66)，
  // 但被砍掉的一半赔率更大（冲高均值 2.10% vs 1.90%），日总期望持平（0.692 vs 0.680 %/日），
  // 且会造出"某天一个候选都没有"的体验。现改为由打分层按档给分（见 services/short-term-strategies/score.ts；
  // 同日打分层口径从「冲高胜率」切到「冲高幅度」后，该维度由"缩量加分"翻转为"放量加分"）。
  // confVolRatio 仍照常输出到 metrics，供打分/展示使用。

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
      confVolRatio: round(confVolRatio),
    },
  };
}
