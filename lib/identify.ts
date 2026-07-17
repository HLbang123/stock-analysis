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
 * 从输入字符串中提取市场前缀和纯数字代码
 */
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
