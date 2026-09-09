/**
 * 双龙战法 策略引擎（纯逻辑）
 * 规则见 docs/short-term-strategies.md 策略三。
 * 二板封板时间先后由用户自行比对，不在引擎内过滤。
 *
 * ⚠️ 2026-09-11「双龙·回踩」已**完全删除**，仅保留「二板打板」一种买入方式。
 *    删除依据（十年 2017~2026，6,986 条回踩信号）：
 *      · 可实现超额 −0.741pp（逐日等权 t=−9.43），**十年 0/10 年为正**
 *      · 每笔期望（挂6%止盈、扣 0.15% 成本）**−1.081%**，真实胜率仅 42.2%，盈亏比 0.80
 *      · 文档旧口径「次日最高价 +2.61%、胜率 74.5%」是**不可实现的冲高幻觉**
 *        （全市场随机票的同一口径胜率就有 87.2%）
 *    证据与复现脚本见 docs/memory/backtest-metric-and-limitup.md。
 */

export interface DoubleDragonBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  preClose?: number | null;
  turnoverRate?: number | null;
}

export interface DoubleDragonConfig {
  limitPct: number;
  limitTolerance: number;
  firstBoardBodyPct: number;
  breakoutLookback: number;
  firstBoardVolRatio: number;
}

export const DEFAULT_DOUBLE_DRAGON_CONFIG: DoubleDragonConfig = {
  limitPct: 0.10,
  limitTolerance: 0.01,
  firstBoardBodyPct: 5.0,
  breakoutLookback: 60,
  firstBoardVolRatio: 1.5,
};

export interface DoubleDragonSignal {
  matched: boolean;
  board2Index: number;
  reason: string;
  failedChecks: string[];
  entryPrice: number;
  entryDate: string;
  exitOpen: number | null;
  exitHigh: number | null;
  retOpen: number | null;
  retHigh: number | null;
  firstBoardBodyPct: number;
  secondOneWord: boolean;
}

function round(n: number, d = 2): number {
  const p = Math.pow(10, d);
  return Math.round(n * p) / p;
}

function prevCloseOf(bars: DoubleDragonBar[], i: number): number | null {
  const bar = bars[i];
  if (bar.preClose != null && bar.preClose > 0) return bar.preClose;
  return i > 0 ? bars[i - 1].close : null;
}

function isLimitUp(b: DoubleDragonBar, prev: number, cfg: DoubleDragonConfig): boolean {
  const limit = round(prev * (1 + cfg.limitPct));
  return Math.abs(b.close - limit) <= cfg.limitTolerance && b.high >= limit - cfg.limitTolerance;
}

function isOneWord(b: DoubleDragonBar, prev: number, cfg: DoubleDragonConfig): boolean {
  const limit = round(prev * (1 + cfg.limitPct));
  return b.open >= limit - cfg.limitTolerance && (b.high - b.low) <= limit * 0.0015;
}

function firstBoardOk(bars: DoubleDragonBar[], firstIdx: number, cfg: DoubleDragonConfig): string[] {
  const fail: string[] = [];
  const b0 = bars[firstIdx];
  const prev0 = prevCloseOf(bars, firstIdx);
  if (prev0 == null) return ['no_prev_close'];
  if (!isLimitUp(b0, prev0, cfg)) fail.push('first_board_not_limit_up');
  if (isOneWord(b0, prev0, cfg)) fail.push('first_board_one_word');
  // 2026-08-27 用户定稿：首板只看实体板/非一字（非一字即实体板），不卡实体大小、突破和放量。
  // 连板数==2 由日线硬过滤；封板时间早晚由用户自行比对。
  return fail;
}

export function detectDoubleDragonBoard(
  bars: DoubleDragonBar[],
  board2Idx: number,
  config: Partial<DoubleDragonConfig> = {}
): DoubleDragonSignal {
  const cfg = { ...DEFAULT_DOUBLE_DRAGON_CONFIG, ...config };
  const fail: string[] = [];
  if (board2Idx < 1) fail.push('data_insufficient');
  else {
    const firstIdx = board2Idx - 1;
    fail.push(...firstBoardOk(bars, firstIdx, cfg));
    const b1 = bars[board2Idx];
    const prev1 = prevCloseOf(bars, board2Idx);
    if (prev1 == null) fail.push('no_prev_close_board2');
    else if (!isLimitUp(b1, prev1, cfg)) fail.push('second_board_not_limit_up');
  }
  // 必须是「恰好二板」：二板前一天不能也是涨停（否则就是 3 板及以上，不是双龙战法的二板打板点）
  if (board2Idx >= 2) {
    const beforeFirst = prevCloseOf(bars, board2Idx - 2);
    if (beforeFirst != null && isLimitUp(bars[board2Idx - 2], beforeFirst, cfg)) {
      fail.push('board2_not_exact_second');
    }
  }

  const entryPrice = board2Idx >= 1 && prevCloseOf(bars, board2Idx) != null ? round(prevCloseOf(bars, board2Idx)! * (1 + cfg.limitPct)) : 0;
  const next = bars[board2Idx + 1] ?? null;
  const exitOpen = next ? next.open : null;
  const exitHigh = next ? next.high : null;
  const retOpen = exitOpen != null && entryPrice > 0 ? round(((exitOpen - entryPrice) / entryPrice) * 100) : null;
  const retHigh = exitHigh != null && entryPrice > 0 ? round(((exitHigh - entryPrice) / entryPrice) * 100) : null;
  const matched = fail.length === 0;
  const firstBoard = board2Idx >= 1 ? bars[board2Idx - 1] : null;
  const firstPrev = firstBoard ? prevCloseOf(bars, board2Idx - 1) : null;
  const firstBoardBodyPct = firstBoard && firstPrev ? round(((firstBoard.close - firstBoard.open) / firstPrev) * 100) : 0;
  const secondOneWord = board2Idx >= 1 && prevCloseOf(bars, board2Idx) != null ? isOneWord(bars[board2Idx], prevCloseOf(bars, board2Idx)!, cfg) : false;
  return {
    matched,
    board2Index: board2Idx,
    reason: matched ? '双龙二板打板形态符合' : fail[0],
    failedChecks: fail,
    entryPrice,
    entryDate: bars[board2Idx]?.date ?? '',
    exitOpen,
    exitHigh,
    retOpen,
    retHigh,
    firstBoardBodyPct,
    secondOneWord,
  };
}

export function scanDoubleDragonBoardSignals(
  bars: DoubleDragonBar[],
  config: Partial<DoubleDragonConfig> = {}
): DoubleDragonSignal[] {
  const out: DoubleDragonSignal[] = [];
  for (let i = 1; i < bars.length; i++) {
    const sig = detectDoubleDragonBoard(bars, i, config);
    if (sig.matched) out.push(sig);
  }
  return out;
}
