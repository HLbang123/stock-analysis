/**
 * 涨停 + 三连阴 策略引擎（纯逻辑）
 * 规则见 docs/short-term-strategies.md 策略一。
 */

export interface ThreeYinBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  preClose?: number | null;
  turnoverRate?: number | null;
}

export interface LimitUpThreeYinConfig {
  limitPct: number;
  limitTolerance: number;
  minYinBodyPct: number;
  maxYinBodyPct: number;
  requireTrueYin: boolean;
  requireVolumeShrinking: boolean;
}

export const DEFAULT_LIMIT_UP_THREE_YIN_CONFIG: LimitUpThreeYinConfig = {
  limitPct: 0.10,
  limitTolerance: 0.01,
  minYinBodyPct: 0.05,
  maxYinBodyPct: 3.0,
  requireTrueYin: true,
  requireVolumeShrinking: true,
};

export interface LimitUpThreeYinSignal {
  matched: boolean;
  yinIndex: number;
  reason: string;
  failedChecks: string[];
  metrics: {
    limitUpIndex: number;
    limitPrice: number;
    yinBodies: [number, number, number];
    volumes: [number, number, number, number];
    entryClose: number;
    nextOpen: number | null;
    nextHigh: number | null;
    retOpen: number | null;
    retHigh: number | null;
  };
}

function round(n: number, d = 2): number {
  const p = Math.pow(10, d);
  return Math.round(n * p) / p;
}

function prevCloseOf(bars: ThreeYinBar[], i: number): number | null {
  const bar = bars[i];
  if (bar.preClose != null && bar.preClose > 0) return bar.preClose;
  return i > 0 ? bars[i - 1].close : null;
}

function bodyPct(bar: ThreeYinBar): number {
  return bar.open > 0 ? ((bar.open - bar.close) / bar.open) * 100 : 0;
}

export function detectLimitUpThreeYinAt(
  bars: ThreeYinBar[],
  idx: number,
  config: Partial<LimitUpThreeYinConfig> = {}
): LimitUpThreeYinSignal {
  const cfg = { ...DEFAULT_LIMIT_UP_THREE_YIN_CONFIG, ...config };
  const fail: string[] = [];
  if (idx < 3) {
    return {
      matched: false, yinIndex: idx, reason: '数据不足', failedChecks: ['data_insufficient'],
      metrics: { limitUpIndex: -1, limitPrice: 0, yinBodies: [0, 0, 0], volumes: [0, 0, 0, 0], entryClose: 0, nextOpen: null, nextHigh: null, retOpen: null, retHigh: null },
    };
  }

  const li = idx - 3;
  const b0 = bars[li];
  const b1 = bars[li + 1];
  const b2 = bars[li + 2];
  const b3 = bars[idx];
  const next = bars[idx + 1] ?? null;

  const prev0 = prevCloseOf(bars, li) ?? b0.open;
  const limitPrice = round(prev0 * (1 + cfg.limitPct));
  const sealed = Math.abs(b0.close - limitPrice) <= cfg.limitTolerance;
  const oneWord = b0.open >= limitPrice - cfg.limitTolerance;
  if (!sealed) fail.push('limit_up_not_sealed');
  if (oneWord) fail.push('limit_up_one_word');
  if (!(b1.open > b0.close && b1.high > b0.high)) fail.push('day1_not_red_new_high');

  const yins = [b1, b2, b3];
  const yinBodies = yins.map((b) => round(bodyPct(b))) as [number, number, number];
  const prevCloses = [b0.close, b1.close, b2.close];
  yins.forEach((b, i) => {
    const isYin = b.close < b.open;
    if (!isYin) fail.push('yin' + (i + 1) + '_not_yin');
    else if (yinBodies[i] < cfg.minYinBodyPct || yinBodies[i] > cfg.maxYinBodyPct) fail.push('yin' + (i + 1) + '_not_small');
    if (cfg.requireTrueYin && !(b.close < prevCloses[i])) fail.push('yin' + (i + 1) + '_not_true');
  });

  const volumes: [number, number, number, number] = [b0.volume, b1.volume, b2.volume, b3.volume];
  if (cfg.requireVolumeShrinking && !(b1.volume > b2.volume && b2.volume > b3.volume)) fail.push('volume_not_shrinking');

  const matched = fail.length === 0;
  const entryClose = b3.close;
  const nextOpen = next ? next.open : null;
  const nextHigh = next ? next.high : null;
  const retOpen = nextOpen != null && entryClose > 0 ? round(((nextOpen - entryClose) / entryClose) * 100) : null;
  const retHigh = nextHigh != null && entryClose > 0 ? round(((nextHigh - entryClose) / entryClose) * 100) : null;

  return {
    matched,
    yinIndex: idx,
    reason: matched ? '涨停+三连阴形态符合' : fail[0],
    failedChecks: fail,
    metrics: { limitUpIndex: li, limitPrice, yinBodies, volumes, entryClose, nextOpen, nextHigh, retOpen, retHigh },
  };
}

export function scanLimitUpThreeYinSignals(
  bars: ThreeYinBar[],
  config: Partial<LimitUpThreeYinConfig> = {}
): LimitUpThreeYinSignal[] {
  const out: LimitUpThreeYinSignal[] = [];
  for (let i = 3; i < bars.length; i++) {
    const sig = detectLimitUpThreeYinAt(bars, i, config);
    if (sig.matched) out.push(sig);
  }
  return out;
}

export interface MinutePoint {
  time: string; // 'HHMM' 或 'HH:MM'
  price: number;
}

function timeToMin(t: string): number {
  const s = t.trim();
  const hm = s.match(/^([0-9]{1,2})[:：]([0-9]{2})$/);
  if (hm) return Number(hm[1]) * 60 + Number(hm[2]);
  const hhmm = s.match(/^([0-9]{4})$/);
  if (hhmm) return Number(hhmm[1].slice(0, 2)) * 60 + Number(hhmm[1].slice(2, 4));
  return Number.NaN;
}

/** 尾盘 5 分钟过滤：横盘或小幅下跌，不快速拉升。 */
export function evaluateEntryTail(
  points: MinutePoint[],
  tailBars = 5,
  maxRangePct = 0.8,
  maxRisePct = 0.3,
  minRisePct = -1.5
): { matched: boolean; trendPct: number; rangePct: number; barCount: number } {
  const sorted = [...points].sort((a, b) => timeToMin(a.time) - timeToMin(b.time));
  if (sorted.length < tailBars) return { matched: false, trendPct: 0, rangePct: 0, barCount: sorted.length };
  const tail = sorted.slice(-tailBars);
  const closes = tail.map((p) => p.price);
  const first = closes[0] || 0;
  const last = closes[closes.length - 1] || 0;
  const high = Math.max(...closes);
  const low = Math.min(...closes);
  const trendPct = first > 0 ? ((last - first) / first) * 100 : 0;
  const rangePct = first > 0 ? ((high - low) / first) * 100 : 0;
  const matched = trendPct <= maxRisePct && trendPct >= minRisePct && rangePct <= maxRangePct;
  return { matched, trendPct: round(trendPct), rangePct: round(rangePct), barCount: tail.length };
}
