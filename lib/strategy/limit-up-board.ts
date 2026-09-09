/**
 * 封板（打板）策略引擎（纯逻辑）
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 口径（2026-09-11 定稿，十年全市场回测 · 2017~2026 · 631 万行样本）
 * ─────────────────────────────────────────────────────────────────────────────
 *   入场 = 当日封于涨停价。盘中扫描时「现价触及涨停价」即成立；尾盘/盘后为收盘价。
 *   出场 = 次日开盘若高于买入价即离场；否则挂 +0.5% 限价，未触及则次日收盘离场。
 *
 * 为什么是这条规则（这是全项目唯一活下来的正期望来源）：
 *
 *   十年全市场 92,186 条收盘封板样本，上述出场下 **胜率 88.7%、净期望 +2.17%**，
 *   逐年净期望 +2.13/+2.33/+2.62/+2.55/+2.20/+2.26/+2.26/+2.74/+2.27/+1.75（%），**10/10 年为正**。
 *   对照组：全市场无脑买入同口径胜率 74.4% 但**净期望 −0.19%**；
 *   实测的另外 18 个入场条件（准涨停、3~7% 涨幅、下跌、换手/市值分档、MACD 各象限、
 *   深跌、放量缩量、收盘位）**净期望全部为负**。封板是唯一有效的入口。
 *
 * ⚠️ 但收益与「买不买得到」严格单调反比（按换手率五等分，净期望）：
 *     换手 1.6%（封死，买不到）+4.37% → 3.8% +2.69% → 6.3% +2.29% → 10.1% +2.16% → 22.1%（随便买）+1.70%
 *   所以本引擎把**换手率下限当可买性闸门**（硬门槛），而把打分留给「闸门之上的期望排序」。
 *
 * ⚠️ 尾部很肥：最差 5% = −5.5%、最差 1% = −10%。88.7% 的胜率是拿 11.3% 的大亏换的。
 *
 * ⚠️ 与仙人指路的关系：无。实测「仙人指路形态 ∩ 高换手封板」的增量仅 +0.33pp 且 n=253（十年），
 *   而仙人指路的三条核心条件（T0 长上影 / 收红 / 收盘位低）在封板票里是**负增量**
 *   （−0.40 / −0.43 / −0.45pp，0/10、0/10、1/10 年为正）。故本引擎不引入任何仙人指路条件。
 *
 * 依据与复现脚本见 docs/memory/backtest-metric-and-limitup.md。
 */

export interface LimitUpBoardBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  preClose?: number | null;
  turnoverRate?: number | null;
}

export interface LimitUpBoardConfig {
  /** 涨停幅度：主板 0.10 / 创业板·科创板 0.20 */
  limitPct: number;
  /**
   * 换手率下限（%）—— **可买性闸门**，不是收益筛选。
   * 换手越低历史期望越高，但低到一定程度就是封死板、根本买不进去（收益再高也是 0）。
   *
   * 2026-09-11 由 5 上调到 10：5% 时日均 23.4 只（p90 43、最多 133），人工挑不过来；
   * 10% 时日均 **11.7 只**（中位 10、p90 22、最多 75），只有 1.3% 的交易日挂零、82% 的日子 ≥5 只。
   * 10~15% 这一档十年净期望 +1.38%，仍在有效区间内（>20% 才明显走低到 +0.23%）。
   */
  turnoverMin: number;
}

export const DEFAULT_LIMIT_UP_BOARD_CONFIG: LimitUpBoardConfig = {
  limitPct: 0.1,
  turnoverMin: 10.0,
};

/** MACD 象限：金叉(g)/死叉(d) × DIF 在零轴上(0)/下(1)；'na' = 历史不足 */
export type LimitUpBoardMacdQuad = 'g0' | 'd0' | 'g1' | 'd1' | 'na';

export interface LimitUpBoardSignal {
  matched: boolean;
  /** 形态触发日 = 封板当日 */
  matchedDate: string;
  reason: string;
  failedChecks: string[];
  /** 买入参考价 = 封板价（涨停价），便于 UI 直接展示 */
  entryPrice: number;
  metrics: {
    limitPrice: number | null;
    /** 触发时点的价（盘中=现价，盘后=收盘价） */
    sealPrice: number | null;
    turnoverRate: number | null;
    /** 连板数（含当日）：1 = 首板 */
    boardCount: number;
    /** 当日是否曾低于涨停价（有过开板 → 存在买入窗口） */
    openBoard: boolean;
    amplitudePct: number | null;
    /**
     * 封板日量比 = 当日量 / 前 5 日均量。**这是本策略最强的排序因子**——
     * 十年/五年都是「越缩量越好」且 10/10、5/5 年为正；与换手率相关系数仅 +0.087，
     * 是独立信息，控制换手后每个换手档内仍单调有效。
     */
    confVolRatio: number | null;
    /** 封板日开盘跳空 %（相对前一日收盘）。高开优先（开盘就强）。 */
    confOpenGap: number | null;
    /** 封板日**前一日**的 MACD 象限（与回测口径一致，见文件头） */
    macdQuad: LimitUpBoardMacdQuad;
  };
}

function round(n: number, d = 2): number {
  const p = Math.pow(10, d);
  return Math.round(n * p) / p;
}

/** 涨停价（四舍五入到分） */
export function limitUpPriceOf(preClose: number, limitPct: number): number {
  return Math.round(preClose * (1 + limitPct) * 100) / 100;
}

function prevCloseOf(bars: LimitUpBoardBar[], i: number): number | null {
  const b = bars[i];
  if (b.preClose != null && b.preClose > 0) return b.preClose;
  return i > 0 ? bars[i - 1].close : null;
}

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
 * MACD 象限（单一事实源实现，与 lib/strategy/xian-ren-zhi-lu.ts 的 computeMacdQuadAt 同算法）。
 * 需要至少 35 根历史（EMA26 稳定 + DEA 9）；不足时返回 'na'。
 */
export function computeQuadAt(
  bars: LimitUpBoardBar[],
  idx: number
): { dif: number; dea: number; quad: LimitUpBoardMacdQuad } {
  const MIN_BARS = 35;
  if (idx < MIN_BARS - 1 || idx >= bars.length) return { dif: 0, dea: 0, quad: 'na' };
  const closes: number[] = [];
  for (let i = 0; i <= idx; i++) closes.push(bars[i].close);
  const e12 = emaSeries(closes, 12);
  const e26 = emaSeries(closes, 26);
  const dif = closes.map((_, i) => e12[i] - e26[i]);
  const dea = emaSeries(dif, 9);
  const d = dif[idx];
  const e = dea[idx];
  if (!Number.isFinite(d) || !Number.isFinite(e)) return { dif: 0, dea: 0, quad: 'na' };
  const quad: LimitUpBoardMacdQuad = d > e ? (d > 0 ? 'g0' : 'g1') : d > 0 ? 'd0' : 'd1';
  return { dif: d, dea: e, quad };
}

/** 连板数：从 idx 往前数连续封板的天数（含 idx 本身）。 */
function countBoards(bars: LimitUpBoardBar[], idx: number, limitPct: number): number {
  let n = 0;
  for (let i = idx; i >= 1; i--) {
    const prev = prevCloseOf(bars, i);
    if (prev == null || prev <= 0) break;
    const lp = limitUpPriceOf(prev, limitPct);
    const b = bars[i];
    if (b.close >= lp - 0.005 && b.high >= lp - 0.005) n += 1;
    else break;
  }
  return n;
}

/**
 * 判定 bars[idx] 当日是否构成「封板」候选。
 *
 * 语义：idx 通常是序列最后一根 bar。盘中扫描时该 bar 的 close = 实时现价，
 * high/low 为当日至今的高低；盘后为真实收盘。
 */
export function detectLimitUpBoardAt(
  bars: LimitUpBoardBar[],
  idx: number,
  config: Partial<LimitUpBoardConfig> = {}
): LimitUpBoardSignal {
  const cfg = { ...DEFAULT_LIMIT_UP_BOARD_CONFIG, ...config };
  const b = bars[idx];
  const empty = (reason: string, fail: string[]): LimitUpBoardSignal => ({
    matched: false,
    matchedDate: b?.date ?? '',
    reason,
    failedChecks: fail,
    entryPrice: 0,
    metrics: {
      limitPrice: null,
      sealPrice: b ? round(b.close) : null,
      turnoverRate: b?.turnoverRate != null ? round(b.turnoverRate) : null,
      boardCount: 0,
      openBoard: false,
      amplitudePct: null,
      confVolRatio: null,
      confOpenGap: null,
      macdQuad: 'na',
    },
  });

  if (!b || idx < 1) return empty('数据不足', ['data_insufficient']);
  const prev = prevCloseOf(bars, idx);
  if (prev == null || prev <= 0) return empty('数据不足', ['data_insufficient']);

  const fail: string[] = [];
  const lp = limitUpPriceOf(prev, cfg.limitPct);
  // 实时行情保留两位小数，留 0.005 容差避免因取整把真封板判掉
  const sealed = b.close >= lp - 0.005;
  const touched = b.high >= lp - 0.005;
  const openBoard = b.low < lp - 0.005;
  const amplitudePct = ((b.high - b.low) / prev) * 100;
  const boardCount = countBoards(bars, idx, cfg.limitPct);
  const macdQuad = computeQuadAt(bars, idx - 1).quad;

  // 封板日量比 = 当日量 / 前 5 日均量（口径与回测脚本逐字一致）
  let vSum = 0, vCnt = 0;
  for (let j = idx - 5; j < idx; j++) {
    if (j >= 0) { vSum += bars[j].volume; vCnt += 1; }
  }
  const confVolRatio = vCnt > 0 && vSum > 0 ? b.volume / (vSum / vCnt) : null;
  // 封板日开盘跳空 %（相对前一日收盘）
  const prevDayClose = bars[idx - 1].close;
  const confOpenGap = prevDayClose > 0 ? ((b.open - prevDayClose) / prevDayClose) * 100 : null;

  if (!touched) fail.push('never_touched_limit');
  if (!sealed) fail.push('not_sealed');

  // 换手率是**可买性闸门**：缺值时不静默放行（否则会把封死板当可买候选报出去）
  const turnover = b.turnoverRate != null && Number.isFinite(b.turnoverRate) ? b.turnoverRate : null;
  if (turnover == null) fail.push('turnover_unknown');
  else if (turnover < cfg.turnoverMin) fail.push('turnover_too_low');

  const matched = fail.length === 0;
  return {
    matched,
    matchedDate: b.date,
    reason: matched ? '当日封板且换手充分' : fail[0],
    failedChecks: fail,
    entryPrice: matched ? round(b.close) : 0,
    metrics: {
      limitPrice: round(lp),
      sealPrice: round(b.close),
      turnoverRate: turnover != null ? round(turnover) : null,
      boardCount,
      openBoard,
      amplitudePct: round(amplitudePct),
      confVolRatio: confVolRatio != null ? round(confVolRatio) : null,
      confOpenGap: confOpenGap != null ? round(confOpenGap) : null,
      macdQuad,
    },
  };
}
