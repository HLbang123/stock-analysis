/**
 * 龙四阴 策略引擎（纯逻辑）
 * 规则见 docs/short-term-strategies.md 策略四。
 * 涨停（首板、非一字、放量、接近新高）后连续四根阴线，第 4 阴收盘为买点。
 */

export interface DragonFourYinBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  preClose?: number | null;
  turnoverRate?: number | null;
}

export interface DragonFourYinConfig {
  limitPct: number;
  limitTolerance: number;
  volBaseDays: number;   // 放量基数：前 N 日均量
  minVolRatio: number;   // 涨停量 ≥ 均量 × 该值
  nearHighDays: number;  // 接近新高窗口：前 N 日最高
  nearHighRatio: number; // 涨停收盘 ≥ 前高 × 该值
  minBodyPct: number;    // 第 1 阴最小实体
  maxBodyPct: number;    // 第 1 阴最大实体
}

export const DEFAULT_DRAGON_FOUR_YIN_CONFIG: DragonFourYinConfig = {
  limitPct: 0.10,
  limitTolerance: 0.01,
  volBaseDays: 10,
  minVolRatio: 1.5,
  nearHighDays: 20,
  nearHighRatio: 0.95,
  minBodyPct: 0.05,
  maxBodyPct: 8.0,
};

export interface DragonFourYinSignal {
  matched: boolean;
  boardIndex: number;
  reason: string;
  failedChecks: string[];
  entryPrice: number;
  entryDate: string;
  metrics: {
    boardDate: string;
    yinBodies: number[];
    volRatio: number | null;
    nearHighPct: number | null;
    entryClose: number;
  };
}

function round(n: number, d = 2): number {
  const p = Math.pow(10, d);
  return Math.round(n * p) / p;
}

function prevCloseOf(bars: DragonFourYinBar[], i: number): number | null {
  const b = bars[i];
  if (b.preClose != null && b.preClose > 0) return b.preClose;
  return i > 0 ? bars[i - 1].close : null;
}

function isLimitUp(b: DragonFourYinBar, prev: number, cfg: DragonFourYinConfig): boolean {
  const limit = round(prev * (1 + cfg.limitPct));
  return Math.abs(b.close - limit) <= cfg.limitTolerance && b.high >= limit - cfg.limitTolerance;
}

function isOneWord(b: DragonFourYinBar, prev: number, cfg: DragonFourYinConfig): boolean {
  const limit = round(prev * (1 + cfg.limitPct));
  return b.open >= limit - cfg.limitTolerance && (b.high - b.low) <= limit * 0.0015;
}

export function detectDragonFourYinAt(
  bars: DragonFourYinBar[],
  idx: number,
  config: Partial<DragonFourYinConfig> = {}
): DragonFourYinSignal {
  const cfg = { ...DEFAULT_DRAGON_FOUR_YIN_CONFIG, ...config };
  const fail: string[] = [];
  if (idx < 4) {
    return {
      matched: false, boardIndex: -1, reason: '数据不足', failedChecks: ['data_insufficient'],
      entryPrice: 0, entryDate: '',
      metrics: { boardDate: '', yinBodies: [], volRatio: null, nearHighPct: null, entryClose: 0 },
    };
  }

  const b0 = bars[idx - 4]; // 涨停
  const b1 = bars[idx - 3];
  const b2 = bars[idx - 2];
  const b3 = bars[idx - 1];
  const b4 = bars[idx];     // 第 4 阴（买点）

  const prev0 = prevCloseOf(bars, idx - 4) ?? b0.open;
  if (!isLimitUp(b0, prev0, cfg)) fail.push('board_not_limit_up');
  else if (isOneWord(b0, prev0, cfg)) fail.push('board_one_word');
  // 首板：前一日不能也是涨停
  if (idx >= 5) {
    const beforeBoard = prevCloseOf(bars, idx - 5);
    if (beforeBoard != null && isLimitUp(bars[idx - 5], beforeBoard, cfg)) fail.push('board_not_first');
  }
  // 放量：涨停量 ≥ 前 N 日均量 × minVolRatio
  let volSum = 0, volCnt = 0;
  for (let j = idx - 4 - cfg.volBaseDays; j < idx - 4; j++) {
    if (j >= 0) { volSum += bars[j].volume; volCnt++; }
  }
  const volRatio = volCnt > 0 ? b0.volume / (volSum / volCnt) : null;
  if (volRatio != null && volRatio < cfg.minVolRatio) fail.push('board_not_volume');
  // 接近新高：涨停收盘 ≥ 前 N 日最高 × nearHighRatio
  let mx = 0;
  for (let j = Math.max(0, idx - 4 - cfg.nearHighDays); j < idx - 4; j++) mx = Math.max(mx, bars[j].high);
  const nearHighPct = mx > 0 ? b0.close / mx : null;
  if (nearHighPct != null && nearHighPct < cfg.nearHighRatio) fail.push('board_not_near_high');

  // 第 1 阴高开
  if (!(b1.open > b0.close)) fail.push('yin1_not_gap_up');

  const yins = [b1, b2, b3, b4];
  const yinBodies: number[] = [];
  for (let k = 0; k < 4; k++) {
    const y = yins[k];
    if (!(y.close < y.open)) { fail.push('yin' + (k + 1) + '_not_yin'); continue; }
    const body = (y.open - y.close) / y.open * 100;
    yinBodies.push(round(body));
    if (k === 0 && !(body >= cfg.minBodyPct && body <= cfg.maxBodyPct)) fail.push('yin1_not_small');
  }

  const matched = fail.length === 0;
  return {
    matched,
    boardIndex: idx - 4,
    reason: matched ? '龙四阴形态符合' : fail[0],
    failedChecks: fail,
    entryPrice: round(b4.close),
    entryDate: b4.date,
    metrics: {
      boardDate: b0.date,
      yinBodies,
      volRatio: volRatio != null ? round(volRatio) : null,
      nearHighPct: nearHighPct != null ? round(nearHighPct * 100) : null,
      entryClose: round(b4.close),
    },
  };
}
