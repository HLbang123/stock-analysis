/**
 * AI 筛选 — 市场环境三态 + 数据新鲜度（2026-08-14 译自 a-share-accumulation-breakout market_regime.py）
 *
 * 与个股级风险层（risk.ts）互补：这是市场级状态，只标记不拦截——
 * 本系统是筛选工具而非组合管理器，防守期照样出结果，但 run 打上标记、UI 展示徽章，
 * 仓位决策交给使用者（与 2026-08-14 移除同板块限额的哲学一致）。
 *
 * 数据基础：market_breadth（MA55 上方占比，compute-market-breadth 每日算）
 *          + rps_scores.ret_20 全市场中位数（等权 20 日收益代理指数）。
 * 原项目用沪深300 close vs MA20 + 20日涨幅，本项目无指数日线表，用宽度指标等价替代。
 */

import { prisma } from '@/lib/db';

export type MarketRegime = 'attack' | 'neutral' | 'defense';

export interface RegimeInfo {
  regime: MarketRegime;
  aboveMa55Ratio: number | null; // 旧口径（breadth fallback 时才有值）
  ratioDelta5d: number | null;
  ret20Median: number | null;
  regimeDay?: number | null;     // calendar 口径：当前状态持续交易日数
  source?: 'calendar' | 'breadth'; // 判定来源（calendar=复盘日历已回测口径）
}

/**
 * 三态判定（阈值偏保守，宁缺毋滥）：
 *   defense: 占比 ≤35% 或 20日中位收益 ≤ -4%
 *   attack:  占比 ≥55% 且 20日中位收益 > 0
 *   其余 neutral；数据缺失一律 neutral（不阻塞流水线）
 */
export async function detectMarketRegime(): Promise<RegimeInfo> {
  // 优先读复盘日历口径（services/review-calendar/regime.ts，经 10 年回测验证）。
  // 复盘日历与 AI 筛选共用同一「市场三态」，避免同日两处结论打架（双指标源前车之鉴）。
  try {
    const row = await prisma.$queryRawUnsafe<{ regime: string; regime_day: number | null }[]>(
      `SELECT regime, regime_day FROM review_calendar_days ORDER BY trade_date DESC LIMIT 1`
    );
    if (row.length && row[0].regime && ['attack', 'neutral', 'defense'].includes(row[0].regime)) {
      return {
        regime: row[0].regime as MarketRegime,
        aboveMa55Ratio: null,
        ratioDelta5d: null,
        ret20Median: null,
        regimeDay: row[0].regime_day,
        source: 'calendar',
      };
    }
  } catch {
    // 表不存在/未建时走下方 fallback，不阻塞筛选流水线
  }

  // fallback：旧口径（MA55 上方占比 + 全市场 20 日收益中位数），表尚未物化时兜底
  try {
    const breadth = await prisma.marketBreadth.findMany({
      orderBy: { tradeDate: 'desc' },
      take: 6,
      select: { aboveMa55Ratio: true },
    });
    const ratio = breadth[0]?.aboveMa55Ratio ?? null;
    const ratioDelta5d = ratio != null && breadth.length >= 6 && breadth[5].aboveMa55Ratio != null
      ? ratio - breadth[5].aboveMa55Ratio
      : null;

    const med = await prisma.$queryRawUnsafe<{ med: number | null }[]>(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY ret_20) AS med
       FROM rps_scores WHERE "calcDate" = (SELECT MAX("calcDate") FROM rps_scores)`
    );
    const ret20Median = med[0]?.med != null ? Number(med[0].med) : null;

    let regime: MarketRegime = 'neutral';
    if (ratio != null && ratio <= 0.35) regime = 'defense';
    else if (ret20Median != null && ret20Median <= -4) regime = 'defense';
    else if (ratio != null && ratio >= 0.55 && ret20Median != null && ret20Median > 0) regime = 'attack';

    return { regime, aboveMa55Ratio: ratio, ratioDelta5d, ret20Median, source: 'breadth' };
  } catch {
    return { regime: 'neutral', aboveMa55Ratio: null, ratioDelta5d: null, ret20Median: null, source: 'breadth' };
  }
}

/**
 * 数据新鲜度：barDate 距期望最近交易日的工作日滞后数。
 * 期望 = 今天（工作日且已过 15 点收盘入库窗口）否则前一工作日。
 * 注意：法定节假日未剔除，长假后首日 sync 前可能误报 1-2 天——只作降级标记，无害。
 * lag ≥ 2 视为数据过期。
 */
export function tradingDayLag(barDate: string, now = new Date()): number {
  const y = Number(barDate.slice(0, 4));
  const m = Number(barDate.slice(4, 6)) - 1;
  const d = Number(barDate.slice(6, 8));
  const bar = new Date(y, m, d);

  // 期望最近交易日
  const expected = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dow = expected.getDay();
  if (dow === 0) expected.setDate(expected.getDate() - 2);       // 周日→周五
  else if (dow === 6) expected.setDate(expected.getDate() - 1);  // 周六→周五
  else if (now.getHours() < 15) expected.setDate(expected.getDate() - (dow === 1 ? 3 : 1)); // 盘中→前一工作日

  // barDate 之后到 expected 之间的工作日数
  let lag = 0;
  const cur = new Date(bar);
  while (cur < expected) {
    cur.setDate(cur.getDate() + 1);
    const w = cur.getDay();
    if (w !== 0 && w !== 6) lag++;
  }
  return lag;
}
