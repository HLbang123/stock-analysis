import { KLineData, KLineSeries, RealtimeQuote } from '@/types';

/**
 * 今日日期字符串（YYYY-MM-DD），按北京时区。
 * 数据源（腾讯/新浪/东财）返回的 date / updateTime 都是北京日期，
 * 之前用 UTC toISOString 会在北京 00:00-08:00 得到前一天（虽然那时盘中无数据，
 * 但用北京时区更正确且与数据源一致）。
 */
export function beijingTodayStr(): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const y = parts.find(p => p.type === 'year')!.value;
  const m = parts.find(p => p.type === 'month')!.value;
  const d = parts.find(p => p.type === 'day')!.value;
  return `${y}-${m}-${d}`;
}

/**
 * 用实时行情构建"今日 K 线"，并合并进历史 K 线（替换历史中同日数据）
 * 用于规则检测：盘中需以实时价格作为今日 K 线，否则规则会基于过时收盘价
 */
export function buildUpdatedKLines(quote: RealtimeQuote, kLines: KLineData[]): KLineData[] {
  const todayStr = beijingTodayStr();
  const lastDate = kLines.length > 0 ? kLines[kLines.length - 1].date : '';

  // 最新 K 线已是今天 → 盘中更新：替换最后一根为实时数据
  if (lastDate === todayStr) {
    const historical = kLines.slice(0, -1);
    return [...historical, {
      date: todayStr, open: quote.open, high: quote.high,
      low: quote.low, close: quote.price, volume: quote.volume,
    }];
  }

  // 行情数据包含今日日期（如 "2026-07-18 14:30"）→ 交易日盘中，追加
  if (quote.updateTime && quote.updateTime.startsWith(todayStr)) {
    return [...kLines, {
      date: todayStr, open: quote.open, high: quote.high,
      low: quote.low, close: quote.price, volume: quote.volume,
    }];
  }

  // 行情非今日（周末/节假日）→ 不追加
  return kLines;
}

/**
 * 把 K 线序列显式拆成"已完成日K"与"盘中合成 bar"。
 *
 * buildUpdatedKLines 在交易日会把盘中价合成成最后一根 bar（date=今日）塞进数组。
 * 不同指标对这根合成 bar 的态度不同：
 *   - RSI / 量能基线 / 箱体：只该用已完成日K（合成 bar 的盘中涨跌/部分成交量会污染）
 *   - MA / MACD / 布林 / BIAS：要用含合成 bar 的序列（同花顺盘中实时跳动）
 * 本函数把"最后一根是否合成 bar"的判断集中到这一处，引擎据此选用 completedBars
 * 或 combinedBars()，不再各自手写 slice(0,-1) / date===today 防御。
 *
 * 判定：最后一根 date === 今日(北京) 即视为合成 bar。盘后今日 bar 已收盘但仍会被
 * 剥离（pre-existing 行为，保持不回归；集中后可单独优化）。
 */
export function splitKLines(kLines: KLineData[]): KLineSeries {
  if (kLines.length === 0) return { completedBars: [], intradayBar: null };
  const todayStr = beijingTodayStr();
  const last = kLines[kLines.length - 1];
  if (last.date === todayStr) {
    return { completedBars: kLines.slice(0, -1), intradayBar: last };
  }
  return { completedBars: kLines, intradayBar: null };
}

/** 合并回含盘中合成 bar 的完整序列（供 MA/MACD/布林 等盘中实时指标使用）。 */
export function combinedBars(s: KLineSeries): KLineData[] {
  return s.intradayBar ? [...s.completedBars, s.intradayBar] : s.completedBars;
}

export type MaCrossState = 'golden' | 'death' | 'pending';

/**
 * 盘中成交量时间归一化系数 (0,1]。
 * 预警在交易时段跑时，合成 bar 的 volume 是半天累积量，直接和全日基线比会
 * 上午漏报放量、盘中误报缩量；比较前应用 volume / pace 折算成等效全日量。
 * A股成交量日内呈 U 形，分段线性锚点：10:00≈30% / 11:30≈55% / 14:00≈80% / 15:00=100%；
 * 开盘前 floor 0.1（防集合竞价小量被过度放大），午休恒 0.55，盘后/非交易时段返回 1。
 * updateTime 形如 "2026-07-18 14:30"（行情自带时间）；缺失时按当前北京时间。
 */
export function intradayVolumePace(updateTime?: string): number {
  const T = (h: number, mi: number) => h * 60 + mi;
  let mins: number | null = null;
  // 防御：updateTime 可能是 UTC ISO（"2026-08-05T06:50Z"）或过期值，
  // 解析出的时间必须落在交易时段 9:30~16:00 才采用，否则回落本地北京时间（显式 Asia/Shanghai，与服务器时区无关）
  const m = updateTime?.match(/(\d{1,2}):(\d{2})/);
  if (m) {
    const cand = Number(m[1]) * 60 + Number(m[2]);
    if (cand >= T(9, 30) && cand <= T(16, 0)) mins = cand;
  }
  if (mins == null) {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date());
    mins = Number(parts.find(p => p.type === 'hour')!.value) * 60 + Number(parts.find(p => p.type === 'minute')!.value);
  }
  if (mins < T(9, 30)) return 0.1;
  if (mins < T(10, 0)) return 0.1 + (0.3 - 0.1) * (mins - T(9, 30)) / 30;
  if (mins < T(11, 30)) return 0.3 + (0.55 - 0.3) * (mins - T(10, 0)) / 90;
  if (mins < T(13, 0)) return 0.55; // 午休量不增长
  if (mins < T(14, 0)) return 0.55 + (0.8 - 0.55) * (mins - T(13, 0)) / 60;
  if (mins < T(15, 0)) return 0.8 + (1 - 0.8) * (mins - T(14, 0)) / 60;
  return 1;
}

/**
 * MA5/MA13 交叉状态（与详情页 trendStatus、扫描器「即将金叉」同源口径）：
 *  - golden/death：最近 3 根内发生上穿/下穿
 *  - pending：尚未金叉，但 MA5<MA13 差距 <2% 且 MA5 在上行（扫描器即将金叉定义）
 * closes 最后一根可传盘中实时价（详情页同款做法），无实时价就传纯日K收盘序列。
 * 数据不足（<15 根）或无信号返回 null。
 */
export function computeMaCross(closes: number[]): MaCrossState | null {
  if (closes.length < 15) return null;
  const maSeries = (p: number) => {
    const out: number[] = [];
    let sum = 0;
    for (let i = 0; i < closes.length; i++) {
      sum += closes[i];
      if (i >= p) sum -= closes[i - p];
      out.push(i >= p - 1 ? sum / p : NaN);
    }
    return out;
  };
  const ma5 = maSeries(5), ma13 = maSeries(13);
  const n = closes.length - 1;
  for (let i = n; i > n - 3 && i >= 1; i--) {
    const prevBull = ma5[i - 1] > ma13[i - 1];
    const curBull = ma5[i] > ma13[i];
    if (!prevBull && curBull) return 'golden';
    if (prevBull && !curBull) return 'death';
  }
  if (ma5[n] < ma13[n] && (ma13[n] - ma5[n]) / ma13[n] < 0.02 && ma5[n] > ma5[n - 1]) return 'pending';
  return null;
}
