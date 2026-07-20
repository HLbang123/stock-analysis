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
}) {
  const { symbol, name, price, preClose, open, high, low, volume, amount } = args;
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
    updateTime: new Date().toISOString(),
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
