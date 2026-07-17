/**
 * 股票/ETF 代码识别工具
 *
 * A股代码体系：
 * - sh6xxxxx: 上海主板 (600000-605999, 688000-689999)
 * - sz0xxxxx: 深圳主板
 * - sz3xxxxx: 深圳创业板 (300000-301999)
 * - bj8xxxxx: 北京交易所
 * - sh51xxxx: 上海 ETF (510-519, 588xxx)
 * - sz159xxx: 深圳 ETF
 */

export type Market = 'sh' | 'sz' | 'bj';

/**
 * 判断代码是否属于 ETF
 */
export function isETF(code: string): boolean {
  const pure = code.replace(/^(sh|sz|bj)/i, '');
  // 上海ETF: 51xxxx (510-519), 588xxx
  // 深圳ETF: 159xxx
  return /^(51\d{4}|588\d{3}|159\d{3})$/.test(pure);
}

/**
 * 从纯数字代码或完整代码（含 sh/sz/bj 前缀）中识别市场
 */
export function detectMarket(code: string): Market | null {
  // 如果已有明确前缀
  if (/^sh/i.test(code)) return 'sh';
  if (/^sz/i.test(code)) return 'sz';
  if (/^bj/i.test(code)) return 'bj';

  // 从纯数字代码推断市场
  if (/^6\d{5}$/.test(code)) return 'sh';           // 上海主板
  if (/^51\d{4}$/.test(code)) return 'sh';           // 上海ETF (510-519)
  if (/^588\d{3}$/.test(code)) return 'sh';          // 上海科创板ETF
  if (/^(0|3)\d{5}$/.test(code)) return 'sz';        // 深圳主板/创业板
  if (/^159\d{3}$/.test(code)) return 'sz';          // 深圳ETF
  if (/^8\d{5}$/.test(code)) return 'bj';            // 北京交易所

  return null;
}

/**
 * 获取A股市场当前状态（交易日判断简化：周一到周五为交易日）
 */
export function getMarketStatus(): { isOpen: boolean; note: string } {
  const now = new Date();
  const day = now.getDay(); // 0=周日 6=周六
  const h = now.getHours();
  const m = now.getMinutes();
  const time = h * 60 + m; // 分钟数

  const isWeekend = day === 0 || day === 6;

  if (isWeekend) {
    return { isOpen: false, note: '今天是周末，A股休市。以下数据为最近交易日收盘数据。' };
  }

  const isMorning = time >= 570 && time < 690;   // 9:30-11:30
  const isAfternoon = time >= 780 && time < 900;  // 13:00-15:00

  if (isMorning || isAfternoon) {
    const session = isMorning ? '上午' : '下午';
    return { isOpen: true, note: `当前A股正在交易中（${session}盘），价格仍在实时波动，今日K线尚未定型，请以盘中动态视角分析，不宜将当前价位视为收盘价。` };
  }

  if (time < 570) {
    return { isOpen: false, note: '当前为盘前时段，A股尚未开盘。以下数据为最近交易日收盘数据，今日走势尚未展开。' };
  }

  if (time >= 690 && time < 780) {
    return { isOpen: false, note: '当前为午间休市时段。上午交易已结束，下午将于13:00开盘。' };
  }

  // 15:00 之后
  return { isOpen: false, note: 'A股已收盘。以下数据为今日最终收盘数据。' };
}
export function parseCode(input: string): { market: Market; pureCode: string; fullCode: string } | null {
  const trimmed = input.trim().toLowerCase();

  let market: Market | null = null;
  let pureCode = trimmed;

  if (trimmed.startsWith('sh')) {
    market = 'sh';
    pureCode = trimmed.substring(2);
  } else if (trimmed.startsWith('sz')) {
    market = 'sz';
    pureCode = trimmed.substring(2);
  } else if (trimmed.startsWith('bj')) {
    market = 'bj';
    pureCode = trimmed.substring(2);
  } else {
    market = detectMarket(trimmed);
  }

  if (!market) return null;

  return { market, pureCode, fullCode: `${market}${pureCode}` };
}
