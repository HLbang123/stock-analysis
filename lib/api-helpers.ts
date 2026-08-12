import { detectMarket } from '@/lib/identify';

/** 解析股票代码为 { market, pureCode }；无前缀且无法识别时返回 null */
export function normalizeMarketCode(code: string): { market: string; pureCode: string } | null {
  if (code.startsWith('sh') || code.startsWith('sz') || code.startsWith('bj')) {
    return { market: code.substring(0, 2), pureCode: code.substring(2) };
  }
  const detected = detectMarket(code);
  if (!detected) return null;
  return { market: detected, pureCode: code };
}

/** 解码 GBK 编码响应（腾讯/新浪 API 使用 GBK 编码中文） */
export function decodeGBK(buffer: ArrayBuffer): string {
  try {
    return new TextDecoder('gbk').decode(buffer);
  } catch {
    try {
      return new TextDecoder('gb18030').decode(buffer);
    } catch {
      return new TextDecoder('utf-8').decode(buffer);
    }
  }
}

/** 北京时区日期时间字符串（YYYY-MM-DD HH:mm），与数据源口径一致。
 *  勿用 new Date().toISOString()：UTC 时间会被 intradayVolumePace 匹配成"盘前"→ pace=0.1
 *  → 盘中折算 cap 恒生效，放量百分比普遍虚大 2 倍（2026-08-05 哈药/海康 误报根因）。 */
function beijingDateTimeStr(date?: Date): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date ?? new Date());
  const get = (t: string) => parts.find(p => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

/** 供数据源 parser 把行情自带时间戳统一成 updateTime 格式 */
export function formatQuoteTime(date: Date): string {
  return beijingDateTimeStr(date);
}

/** 构建统一的实时行情响应对象 */
export function buildQuoteResponse(args: {
  symbol: string;
  name: string;
  price: number;
  preClose: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  amount: number;
  /** 换手率(%)，行情源自带（腾讯/东财有，新浪无）；深度分析盘中注入用 */
  turnover?: number;
  /** 行情自带时间戳（YYYY-MM-DD HH:mm）；缺省回退服务器当前时间。
   *  非交易日跑分析时行情日期 ≠ 今天，prompt 靠它标注数据归属日，防 LLM 误述为"今日"。 */
  updateTime?: string;
}) {
  const { symbol, name, price, preClose, open, high, low, volume, amount, turnover, updateTime } = args;
  const change = price - preClose;
  const round2 = (n: number) => Math.round(n * 100) / 100;
  return {
    code: symbol,
    name: name || symbol,
    price,
    preClose,
    change: round2(change),
    changePercent: preClose !== 0 ? round2((change / preClose) * 100) : 0,
    high,
    low,
    open,
    volume,
    amount,
    turnover,
    updateTime: updateTime || beijingDateTimeStr(),
  };
}

/** 带重试的 fetch（用于不稳定的外部数据源） */
export async function fetchWithRetry(url: string, options: RequestInit, retries = 2, timeoutMs = 8000): Promise<Response | null> {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return res;
    } catch {
      if (i < retries) await new Promise(r => setTimeout(r, 500));
    }
  }
  return null;
}
