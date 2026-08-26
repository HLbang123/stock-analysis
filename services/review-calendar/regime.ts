/**
 * 市场三态状态机（复盘日历单一事实源）
 * 规则经 10 年回测验证（docs/review-calendar-phase0-backtest.md），
 * 输入为日级快照特征：量能比 volume_ratio / 上涨家数占比 up_ratio / 上证涨跌幅 idx_pct_chg。
 * 状态：attack(活跃) / neutral(震荡) / defense(收缩)，仅相邻跳转，滞回 N 日防抖。
 */

export type Regime = "attack" | "neutral" | "defense";

export const REGIME_UI: Record<Regime, string> = {
  attack: "活跃",
  neutral: "震荡",
  defense: "收缩",
};

export interface RegimeDayInput {
  trade_date: string;
  volume_ratio: number | null;
  advance: number;
  decline: number;
  idx_pct_chg: number | null;
}

export interface RegimeDay {
  regime: Regime;
  regime_day: number;
}

/** 单日三分类（无滞回） */
export function classifyDay(vr: number | null, upRatio: number | null, idxPct: number | null): Regime {
  if (vr != null && upRatio != null && vr >= 1.0 && upRatio >= 0.55) return "attack";
  if (vr != null && vr <= 0.85) return "defense";
  if (upRatio != null && upRatio <= 0.35) return "defense";
  if (idxPct != null && idxPct <= -2) return "defense";
  return "neutral";
}

/** 强确认：当日立即切换，不等滞回窗口 */
function strongAttack(vr: number | null, upRatio: number | null): boolean {
  return vr != null && upRatio != null && vr >= 1.2 && upRatio >= 0.55;
}
function strongDefense(vr: number | null, upRatio: number | null, idxPct: number | null): boolean {
  if (idxPct != null && idxPct <= -2.5) return true;
  if (vr != null && vr <= 0.7) return true;
  if (upRatio != null && upRatio <= 0.2) return true;
  return false;
}

function rank(r: Regime): number { return r === "defense" ? 0 : r === "neutral" ? 1 : 2; }
function clampStep(cur: number, cand: number): number {
  if (Math.abs(cand - cur) <= 1) return cand;
  return cur + (cand > cur ? 1 : -1);
}

/**
 * 按时间序计算三态序列（滞回 N 日，仅相邻跳转）。
 * 返回 Map<trade_date, {regime, regime_day}>，regime_day = 当前状态已持续交易日数（含当日）。
 */
export function computeRegimeSeries(rows: RegimeDayInput[], hysteresis = 5): Map<string, RegimeDay> {
  const out = new Map<string, RegimeDay>();
  let cur: Regime = "neutral";
  let day = 1;
  let atkStreak = 0;
  let defStreak = 0;
  for (const d of rows) {
    const up = d.advance + d.decline;
    const upRatio = up > 0 ? d.advance / up : null;
    const c = classifyDay(d.volume_ratio, upRatio, d.idx_pct_chg);
    atkStreak = c === "attack" ? atkStreak + 1 : 0;
    defStreak = c === "defense" ? defStreak + 1 : 0;
    let cand: Regime;
    if (strongAttack(d.volume_ratio, upRatio)) cand = "attack";
    else if (strongDefense(d.volume_ratio, upRatio, d.idx_pct_chg)) cand = "defense";
    else if (atkStreak >= hysteresis) cand = "attack";
    else if (defStreak >= hysteresis) cand = "defense";
    else if (c === "neutral") cand = "neutral";
    else cand = cur;
    const next = clampStep(rank(cur), rank(cand));
    const nextRegime = (["defense", "neutral", "attack"] as const)[next];
    day = nextRegime === cur ? day + 1 : 1;
    cur = nextRegime;
    out.set(d.trade_date, { regime: cur, regime_day: day });
  }
  return out;
}
