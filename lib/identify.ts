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
 * 获取A股市场当前状态（仅基于时间+周末判断，不含节假日）
 * 如需节假日校验，调用 /api/market-status
 */
export function getMarketStatus(): { isOpen: boolean; note: string } {
  const now = new Date();
  const day = now.getDay();
  const h = now.getHours();
  const m = now.getMinutes();
  const time = h * 60 + m;

  const isWeekend = day === 0 || day === 6;

  if (isWeekend) {
    return { isOpen: false, note: "今天是周末，A股休市。以下数据为最近交易日收盘数据。" };
  }

  const isMorning = time >= 570 && time < 690;
  const isAfternoon = time >= 780 && time < 900;

  if (isMorning || isAfternoon) {
    const session = isMorning ? "上午" : "下午";
    return { isOpen: true, note: `当前A股正在交易中（${session}盘），价格仍在实时波动，今日K线尚未定型，请以盘中动态视角分析，不宜将当前价位视为收盘价。` };
  }

  if (time < 570) return { isOpen: false, note: "当前为盘前时段，A股尚未开盘。以下数据为最近交易日收盘数据，今日走势尚未展开。" };
  if (time >= 690 && time < 780) return { isOpen: false, note: "当前为午间休市时段。上午交易已结束，下午将于13:00开盘。" };

  return { isOpen: false, note: "A股已收盘。以下数据为今日最终收盘数据。" };
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

/**
 * 校验纯数字股票代码（6 位），返回市场与补零后的纯代码
 * 用于 OCR 等场景从截图中提取的代码验证
 */
export function validateStockCode(code: string | number): { market: Market; pureCode: string } | null {
  const pure = String(code).padStart(6, '0');
  const market = detectMarket(pure);
  if (!market) return null;
  return { market, pureCode: pure };
}

/**
 * 从自由文本提取 6 位标的代码（OCR 识别文本 / 用户粘贴文本共用）。
 * 处理链：全角数字→半角（截图常见全角，不转正则完全不认）→ 两段窗口匹配。
 * - 6 位窗口：允许位间夹单个空白/标点（OCR 拆行 "60 0000"、插点 "600.519"），前后非数字。
 * - 7-9 位连续窗口（无分隔符）：仅在混淆归一化副本上跑——字母被映射成数字后，
 *   代码前粘了误读的市场标签/列粘连噪声（"E1600183"→"31600183"，取后 6 位 "600183"）。
 *   无分隔符避免把相邻列（代码+价格 "1600206 52.65"）拼成一条长串。
 * 混淆字符归一化（OCR 把数字认成字母：0→O、1→l、E→3 等，反向映射回数字）；归一化可能造出假串，
 * 由后续名录校验过滤。
 */
export function extractStockCodes(text: string): string[] {
  const sixRegex = /(?<!\d)(?:\d[\s.\-_/·]?){5}\d(?!\d)/g;
  const longRegex = /(?<!\d)\d{7,9}(?!\d)/g;
  const digitsOnly = (s: string) => s.replace(/\D/g, '');
  const half = text.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  const CONFUSE: Record<string, string> = {
    o: '0', O: '0', Q: '0', D: '0', l: '1', I: '1', i: '1', '|': '1', '!': '1',
    Z: '2', z: '2', E: '3', A: '4', a: '4', S: '5', s: '5', G: '6', b: '6',
    T: '7', B: '8', '&': '8', '$': '8', g: '9', q: '9',
  };
  const normalized = half.replace(/[A-Za-z|!&$]/g, (ch) => CONFUSE[ch] ?? ' ');
  const out = new Set<string>();
  for (const variant of [half, normalized]) {
    for (const m of variant.match(sixRegex) || []) {
      // 跳过小数：以 .X/.XX 结尾的是价格/指数（如 3934.09、135.30），不是代码
      if (/\.\d{1,2}$/.test(m)) continue;
      out.add(digitsOnly(m));
    }
  }
  // 7-9 位长串只在归一化副本取后 6 位（原始文本里的长数字是价格/账号，不碰）
  for (const m of normalized.match(longRegex) || []) {
    if (/\.\d{1,2}$/.test(m)) continue;
    out.add(m.slice(-6));
  }
  return [...out];
}
