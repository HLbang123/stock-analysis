import { beijingTodayStr } from '@/lib/stock-helpers';

/**
 * 龙首阴策略（买入侧纯逻辑引擎，不做数据请求）
 *
 * 规则（用户口述，2026-08-27 校准）：
 *   1. 只做龙头/核心总龙头；首阴出现位置在 3~5 板范围。
 *   2. 换手板优先；连续加速一字板次之（连续一字板可以不做）。
 *   3. 首阴优先「假阴真阳」：收盘价高于昨日收盘，但当日是阴线（open > close）。
 *   4. 量能可放大但不能暴增，须仍在近期资金承接范围内。
 *   5. 退潮期/核按钮环境慎用或不用（由调用方用市场情绪数据把关）。
 *   6. 买点：首阴当日预判、首阴次日竞价/快速拉升、或打板买入。卖出侧不管。
 */

export interface DragonBar {
  date: string;                 // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount?: number | null;
  preClose?: number | null;     // 昨收；缺失时用前一根 close 兜底
  turnoverRate?: number | null; // 换手率（%），来自 daily_bars.turnover_rate
}

export interface DragonFirstYinConfig {
  /** 主板涨停幅度 */
  limitPct: number;
  /** 收盘价与涨跌停价的容差（元） */
  limitTolerance: number;
  /** 首阴前连板数量下限（默认 3） */
  minBoards: number;
  /** 兼容字段：高位板不再设上限，保留 99 即可 */
  maxBoards: number;
  /** 高位板阈值：连板数 >= 此值时，首阴只允许假阴真阳 */
  highBoardThreshold: number;
  /** 高位板是否强制假阴真阳 */
  requireFakeYinAtHighBoards: boolean;
  /** 一字板判定：high-low 相对涨停价的百分比上限 */
  oneWordRangePct: number;
  /** 换手板判定：换手率达到该值视为充分换手 */
  minTurnoverRate: number;
  /** 首阴实体上限（%，超过视为核按钮级大阴线） */
  yinBodyMaxPct: number;
  /** 首阴不允许收在跌停价附近 */
  rejectLimitDownYin: boolean;
  /** 首阴量能 / 前 5 日均量 上限（超过视为暴增） */
  maxVolumeRatio: number;
  /** 首阴换手率上限（%，超过视为筹码散得过快） */
  maxYinTurnoverRate: number;
  /** 连板全部为一字板时是否直接跳过（默认只降优先级） */
  skipAllOneWordRun: boolean;
}

export const DEFAULT_DRAGON_FIRST_YIN_CONFIG: DragonFirstYinConfig = {
  limitPct: 0.10,
  limitTolerance: 0.01,
  minBoards: 3,
  maxBoards: 99,
  highBoardThreshold: 5,
  requireFakeYinAtHighBoards: true,
  oneWordRangePct: 0.15,
  minTurnoverRate: 8,
  yinBodyMaxPct: 7,
  rejectLimitDownYin: true,
  maxVolumeRatio: 2.0,
  maxYinTurnoverRate: 45,
  skipAllOneWordRun: false,
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function prevCloseOf(bars: DragonBar[], i: number): number | null {
  const bar = bars[i];
  if (bar.preClose != null && bar.preClose > 0) return bar.preClose;
  return i > 0 ? bars[i - 1].close : null;
}

function isLimitUp(bar: DragonBar, prevClose: number, cfg: DragonFirstYinConfig): boolean {
  const limitPrice = round2(prevClose * (1 + cfg.limitPct));
  return Math.abs(bar.close - limitPrice) <= cfg.limitTolerance && bar.high >= limitPrice - cfg.limitTolerance;
}

function isOneWord(bar: DragonBar, limitPrice: number, cfg: DragonFirstYinConfig): boolean {
  return bar.open >= limitPrice - cfg.limitTolerance
    && (bar.high - bar.low) <= limitPrice * cfg.oneWordRangePct / 100;
}

export type BoardKind = 'oneWord' | 'change';

export interface BoardInfo {
  index: number;
  date: string;
  oneWord: boolean;
  kind: BoardKind;
  turnoverRate: number | null;
  volume: number;
  limitPrice: number;
}

export type RunQuality = 'turnover' | 'mixed' | 'oneWord';

export interface DragonRun {
  boardCount: number;
  boards: BoardInfo[];
  oneWordCount: number;
  changeCount: number;
  trailingOneWordStreak: number;
  quality: RunQuality;
}

/** 从 endIndex 向前数连续涨停板（不跨非涨停日）。endIndex 通常是首阴前一日。 */
export function analyzeDragonRun(
  bars: DragonBar[],
  endIndex: number,
  config: Partial<DragonFirstYinConfig> = {}
): DragonRun | null {
  const cfg = { ...DEFAULT_DRAGON_FIRST_YIN_CONFIG, ...config };
  const boards: BoardInfo[] = [];
  for (let i = endIndex; i >= 0; i--) {
    const bar = bars[i];
    const prev = prevCloseOf(bars, i);
    if (prev == null || prev <= 0) break;
    if (!isLimitUp(bar, prev, cfg)) break;
    const limitPrice = round2(prev * (1 + cfg.limitPct));
    const oneWord = isOneWord(bar, limitPrice, cfg);
    boards.push({
      index: i,
      date: bar.date,
      oneWord,
      kind: oneWord ? 'oneWord' : 'change',
      turnoverRate: bar.turnoverRate ?? null,
      volume: bar.volume,
      limitPrice,
    });
  }
  if (boards.length === 0) return null;
  boards.reverse();

  const oneWordCount = boards.filter((b) => b.oneWord).length;
  const changeCount = boards.length - oneWordCount;
  let trailingOneWordStreak = 0;
  for (let i = boards.length - 1; i >= 0; i--) {
    if (!boards[i].oneWord) break;
    trailingOneWordStreak += 1;
  }
  const quality: RunQuality = changeCount === boards.length ? 'turnover' : oneWordCount === boards.length ? 'oneWord' : 'mixed';

  return { boardCount: boards.length, boards, oneWordCount, changeCount, trailingOneWordStreak, quality };
}

export interface YinInfo {
  index: number;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  prevClose: number;
  bodyPct: number;      // 阴线实体幅度%，正数
  changePct: number;    // 相对昨收涨跌幅%
  isYin: boolean;
  fakeYin: boolean;     // 假阴真阳：open>close 且 close>prevClose
  realYin: boolean;     // 真阴：open>close 且 close<prevClose
  lowerShadowPct: number; // 下影线 / 收盘价 %
  isWash: boolean;      // 日内分歧转一致：长下影 + 收盘高于昨收 + 收盘高于振幅中点
  volume: number;
  turnoverRate: number | null;
  volumeRatio: number;  // 首阴量 / 前5日均量
  recentMaxVolume: number;
  limitDownPrice: number;
  atLimitDown: boolean;
}

export function buildYinInfo(
  bars: DragonBar[],
  idx: number,
  config: Partial<DragonFirstYinConfig> = {}
): YinInfo | null {
  const cfg = { ...DEFAULT_DRAGON_FIRST_YIN_CONFIG, ...config };
  const bar = bars[idx];
  if (!bar) return null;
  const prevClose = prevCloseOf(bars, idx) ?? bar.open;
  const bodyPct = bar.open > 0 ? ((bar.open - bar.close) / bar.open) * 100 : 0;
  const changePct = prevClose > 0 ? ((bar.close - prevClose) / prevClose) * 100 : 0;
  const isYin = bar.close < bar.open;
  const fakeYin = isYin && bar.close > prevClose;
  const realYin = isYin && bar.close < prevClose;
  const lowerShadow = Math.min(bar.open, bar.close) - bar.low;
  const lowerShadowPct = bar.close > 0 ? (lowerShadow / bar.close) * 100 : 0;
  const amplitudeMid = (bar.high + bar.low) / 2;
  const isWash = bar.close > prevClose && lowerShadowPct >= 5 && bar.close > amplitudeMid;
  const recent = bars.slice(Math.max(0, idx - 5), idx);
  const recentVolumes = recent.map((b) => b.volume).filter((v) => v > 0);
  const avgVolume = recentVolumes.length > 0 ? recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length : 0;
  const recentMaxVolume = recentVolumes.length > 0 ? Math.max(...recentVolumes) : 0;
  const volumeRatio = avgVolume > 0 ? bar.volume / avgVolume : 0;
  const limitDownPrice = round2(prevClose * (1 - cfg.limitPct));
  const atLimitDown = bar.close <= limitDownPrice + cfg.limitTolerance;

  return {
    index: idx,
    date: bar.date,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    prevClose,
    bodyPct: round2(bodyPct),
    changePct: round2(changePct),
    isYin,
    fakeYin,
    realYin,
    lowerShadowPct: round2(lowerShadowPct),
    isWash,
    volume: bar.volume,
    turnoverRate: bar.turnoverRate ?? null,
    volumeRatio: round2(volumeRatio),
    recentMaxVolume,
    limitDownPrice,
    atLimitDown,
  };
}

export type DragonSignalType = 'firstYinToday' | 'firstYinYesterday' | 'historical';
export type DragonPriority = 'high' | 'medium' | 'low';

export interface DragonFirstYinSignal {
  matched: boolean;
  yinIndex: number;
  signalType: DragonSignalType;
  reason: string;
  failedChecks: string[];
  summary?: string;
  priority: DragonPriority;
  priorityScore: number;
  run: DragonRun | null;
  yin: YinInfo | null;
}

function buildSignal(
  yinIdx: number,
  run: DragonRun | null,
  yin: YinInfo | null,
  failedChecks: string[],
  signalType: DragonSignalType
): DragonFirstYinSignal {
  const matched = failedChecks.length === 0 && run != null && yin != null;
  let priorityScore = 0;
  if (matched && run && yin) {
    if (yin.fakeYin || yin.isWash) priorityScore += 2;
    if (run.changeCount >= 2) priorityScore += 2;
    else if (run.changeCount === 1) priorityScore += 1;
    if (run.trailingOneWordStreak >= 2) priorityScore -= 1;
    if (run.quality === 'oneWord') priorityScore -= 1;
    if (yin.volumeRatio >= 1 && yin.volumeRatio <= 2) priorityScore += 1;
    if (yin.turnoverRate != null && yin.turnoverRate >= DEFAULT_DRAGON_FIRST_YIN_CONFIG.minTurnoverRate) priorityScore += 1;
  }
  const priority: DragonPriority = priorityScore >= 5 ? 'high' : priorityScore >= 3 ? 'medium' : 'low';
  const summary = matched && run && yin
    ? run.boardCount + '板龙首阴，' + (yin.isWash ? '长下影分歧转一致' : yin.fakeYin ? '假阴真阳' : '真阴') + '，' + (run.quality === 'turnover' ? '换手板' : run.quality === 'oneWord' ? '一字板' : '混合板')
    : undefined;
  return {
    matched,
    yinIndex: yinIdx,
    signalType,
    reason: matched ? '龙首阴形态符合' : failedChecks[0] ?? '不符合',
    failedChecks,
    summary,
    priority,
    priorityScore,
    run,
    yin,
  };
}

/** 在指定位置判定是否构成龙首阴（不限定 signalType）。 */
export function detectDragonFirstYinAt(
  bars: DragonBar[],
  yinIdx: number,
  config: Partial<DragonFirstYinConfig> = {}
): DragonFirstYinSignal {
  const cfg = { ...DEFAULT_DRAGON_FIRST_YIN_CONFIG, ...config };
  const fail: string[] = [];
  if (yinIdx < 1) return buildSignal(yinIdx, null, null, ['data_insufficient'], 'historical');

  const run = analyzeDragonRun(bars, yinIdx - 1, cfg);
  if (!run) fail.push('no_limit_up_run');
  else {
    if (run.boardCount < cfg.minBoards) fail.push('board_count_out_of_range');
    if (cfg.skipAllOneWordRun && run.quality === 'oneWord') fail.push('continuous_one_word_run');
    if (cfg.minTurnoverRate > 0) {
      const changeBoards = run.boards.filter((b) => !b.oneWord);
      const minChangeTurnover = changeBoards.length > 0
        ? Math.min(...changeBoards.map((b) => b.turnoverRate ?? Infinity))
        : Infinity;
      if (!Number.isFinite(minChangeTurnover) || minChangeTurnover < cfg.minTurnoverRate) {
        fail.push('turnover_board_too_low');
      }
    }
  }

  const yin = buildYinInfo(bars, yinIdx, cfg);
  if (!yin) fail.push('yin_data_insufficient');
  else {
    if (!yin.isYin && !yin.isWash) fail.push('not_a_yin');
    else if (yin.isYin && yin.bodyPct > cfg.yinBodyMaxPct) fail.push('yin_body_too_large');
    if (cfg.rejectLimitDownYin && yin.atLimitDown) fail.push('yin_at_limit_down');
    if (yin.volumeRatio > cfg.maxVolumeRatio) fail.push('volume_explosion');
    if (yin.turnoverRate != null && yin.turnoverRate > cfg.maxYinTurnoverRate) fail.push('turnover_too_high');
    if (run && cfg.requireFakeYinAtHighBoards && run.boardCount >= cfg.highBoardThreshold && !(yin.fakeYin || yin.isWash)) {
      fail.push('high_board_not_fake_yin');
    }
  }

  return buildSignal(yinIdx, run, yin, fail, 'historical');
}

/** 扫描整段行情中所有龙首阴（回测/历史复盘用）。 */
export function scanDragonFirstYinSignals(
  bars: DragonBar[],
  config: Partial<DragonFirstYinConfig> = {}
): DragonFirstYinSignal[] {
  const cfg = { ...DEFAULT_DRAGON_FIRST_YIN_CONFIG, ...config };
  const out: DragonFirstYinSignal[] = [];
  for (let i = cfg.minBoards; i < bars.length; i++) {
    const sig = detectDragonFirstYinAt(bars, i, cfg);
    if (sig.matched) out.push(sig);
  }
  return out;
}

/**
 * 实时/最新判定：优先看今天是否构成首阴（首阴当日预判买点），
 * 否则看昨天是否构成首阴（首阴次日竞价/快速拉升买点）。
 */
export function detectLatestDragonFirstYin(
  bars: DragonBar[],
  config: Partial<DragonFirstYinConfig> = {}
): DragonFirstYinSignal | null {
  const n = bars.length;
  if (n < 2) return null;
  const today = beijingTodayStr();
  const last = bars[n - 1];
  const lastIsToday = last.date === today;

  const todaySig = detectDragonFirstYinAt(bars, n - 1, config);
  if (todaySig.matched) {
    return { ...todaySig, signalType: lastIsToday ? 'firstYinToday' : 'historical' };
  }

  const yesterdaySig = detectDragonFirstYinAt(bars, n - 2, config);
  if (yesterdaySig.matched) {
    return { ...yesterdaySig, signalType: 'firstYinYesterday' };
  }
  return null;
}

/** 主板范围过滤：排除创业板、科创板、北交所、ST/退市。 */
export function isMainBoardNonST(tsCode: string, name?: string | null): boolean {
  if (name && /ST|退/.test(name.toUpperCase())) return false;
  const upper = tsCode.toUpperCase();
  if (/.BJ$/.test(upper)) return false;
  const digits = upper.replace(/^[A-Z]+/, '').replace(/.(SH|SZ|BJ)$/, '');
  if (/^(688|689|300|301)/.test(digits)) return false;
  if (/^(4|8|9)/.test(digits)) return false;
  return /^(600|601|603|605|000|001|002|003)/.test(digits);
}

/**
 * 双龙战法（实时过滤，不回测）：
 * 二板要比一板封板时间更早；二板最好是一字板（一字板加分）。
 * 首板/二板封板时间来自涨停池 first_time / limit_list_d first_time。
 */
export interface BoardSealInfo {
  boardNumber: 1 | 2;
  firstLimitTime: string; // 'HH:MM' 或 'HHMM'
  isOneWord: boolean;
}

export interface DoubleDragonResult {
  secondEarlier: boolean;
  oneWordBonus: boolean;
  score: number; // 0=不满足；1=二板更早；2=二板更早且一字板
  reason: string;
}

function parseSealTimeToMinutes(t: string): number | null {
  const s = t.trim();
  const hm = s.match(/^([0-9]{1,2})[:：]([0-9]{2})$/);
  if (hm) return Number(hm[1]) * 60 + Number(hm[2]);
  const hhmm = s.match(/^([0-9]{4})$/);
  if (hhmm) return Number(hhmm[1].slice(0, 2)) * 60 + Number(hhmm[1].slice(2, 4));
  return null;
}

export function evaluateDoubleDragon(first: BoardSealInfo, second: BoardSealInfo): DoubleDragonResult {
  const t1 = parseSealTimeToMinutes(first.firstLimitTime);
  const t2 = parseSealTimeToMinutes(second.firstLimitTime);
  const secondEarlier = t1 != null && t2 != null && t2 < t1;
  const oneWordBonus = second.isOneWord;
  const score = (secondEarlier ? 1 : 0) + (oneWordBonus ? 1 : 0);
  let reason = '二板未早于一板封板';
  if (t1 == null || t2 == null) reason = '封板时间数据不足';
  else if (secondEarlier) reason = oneWordBonus ? '二板早于一板封板，且二板为一字板' : '二板早于一板封板';
  return { secondEarlier, oneWordBonus, score, reason };
}

export type DragonRegime = 'attack' | 'neutral' | 'defense';

export interface DragonRegimeInput {
  limitUpCount: number;
  limitDownCount: number;
  brokenCount?: number;      // 炸板数
  highestBoard: number;      // 全市场最高连板高度
  marketRegime?: DragonRegime | null;
}

export interface DragonRegimeResult {
  mode: DragonRegime;
  tradable: boolean;
  warnings: string[];
}

/** 退潮期/核按钮环境把关：退潮时慎用或不用。 */
export function evaluateDragonRegime(input: DragonRegimeInput): DragonRegimeResult {
  const warnings: string[] = [];
  const broken = input.brokenCount ?? 0;
  const up = input.limitUpCount || 0;
  const brokenRatio = up + broken > 0 ? broken / (up + broken) : 0;

  let mode: DragonRegime = 'neutral';
  if (input.marketRegime === 'defense' || input.limitDownCount >= 12 || brokenRatio >= 0.40) {
    mode = 'defense';
  } else if (input.limitUpCount >= 50 && input.limitDownCount <= 3 && brokenRatio <= 0.25) {
    mode = 'attack';
  }

  if (input.highestBoard < DEFAULT_DRAGON_FIRST_YIN_CONFIG.minBoards) {
    warnings.push('市场最高板不足' + DEFAULT_DRAGON_FIRST_YIN_CONFIG.minBoards + '板，暂无龙头');
  }
  if (input.limitDownCount >= 8) warnings.push('跌停家数偏多，核按钮风险');
  if (brokenRatio >= 0.30) warnings.push('炸板率偏高，退潮迹象');
  if (mode === 'defense') warnings.push('退潮期，策略慎用或不用');

  const tradable = mode !== 'defense'
    && input.highestBoard >= DEFAULT_DRAGON_FIRST_YIN_CONFIG.minBoards;

  return { mode, tradable, warnings };
}
