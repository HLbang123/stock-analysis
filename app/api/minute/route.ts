import { NextRequest, NextResponse } from 'next/server';
import { normalizeMarketCode } from '@/lib/api-helpers';

// 短 TTL 内存缓存 + 在途请求去重
// 自选页一次性并发拉同一只票时，复用同一份结果，避免对腾讯突发打多份请求。
// TTL 8s：做 T 5 分粒度下足够新鲜；8~120s 内拉空时降级到上一份缓存。
const MINUTE_TTL = 8_000;
const MINUTE_MAX_AGE = 120_000;
const minuteCache = new Map<string, { data: any[]; ts: number }>();
const minuteInflight = new Map<string, Promise<any[]>>();

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  if (!code) {
    return NextResponse.json({ error: '缺少 code 参数' }, { status: 400 });
  }

  const parsed = normalizeMarketCode(code) ?? { market: 'sh', pureCode: code };
  const { market, pureCode } = parsed;

  const points = await getMinuteCached(market, pureCode);
  return NextResponse.json(points);
}

/**
 * 带短 TTL 缓存 + 在途去重的分时获取
 */
async function getMinuteCached(market: string, pureCode: string): Promise<any[]> {
  const key = `${market}${pureCode}`;
  const now = Date.now();

  // 1. 新鲜缓存 → 直接返回
  const entry = minuteCache.get(key);
  if (entry && now - entry.ts < MINUTE_TTL) {
    return entry.data;
  }

  // 2. 已有在途请求 → 复用同一 Promise（并发去重）
  const existing = minuteInflight.get(key);
  if (existing) return existing;

  // 3. 发起新请求
  const p = (async () => {
    const fresh = await fetchMinute(market, pureCode);
    if (fresh.length > 0) {
      minuteCache.set(key, { data: fresh, ts: Date.now() });
      return fresh;
    }
    // 拉空 → 降级到未过期(stale)缓存
    if (entry && now - entry.ts < MINUTE_MAX_AGE) return entry.data;
    return fresh;
  })().finally(() => {
    minuteInflight.delete(key);
  });

  minuteInflight.set(key, p);
  return p;
}

/**
 * 实际拉取分时：方案1 腾讯分时 → 方案2 5分K回退
 */
async function fetchMinute(market: string, pureCode: string): Promise<any[]> {
  // 方案1: 腾讯分钟线
  try {
    const points = await tryTencentMinuteOnline(market, pureCode);
    if (points && points.length > 0) return points;
  } catch (e: any) {
    console.log(`[minute] Tencent minute error: ${e.message}`);
  }

  // 方案2: 5分钟K线
  try {
    const points = await tryM5KLine(market, pureCode);
    if (points && points.length > 0) return points;
  } catch (e: any) {
    console.log(`[minute] M5 K-line error: ${e.message}`);
  }

  return [];
}

async function tryTencentMinuteOnline(market: string, pureCode: string) {
  const symbol = `${market}${pureCode}`;
  const url = `http://ifzq.gtimg.cn/appstock/app/minute/query?_var=min_data&code=${symbol}`;

  const res = await fetch(url, {
    headers: { Referer: 'https://gu.qq.com' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return null;

  const text = await res.text();

  const startIdx = text.indexOf('min_data=');
  if (startIdx === -1) return null;
  // 兼容 min_data=(...) 和 min_data={...} 两种格式
  let jsonStart = startIdx + 9; // "min_data=".length
  if (text[jsonStart] === '(') jsonStart++;
  let depth = 0, jsonEnd = jsonStart;
  for (let i = jsonStart; i < text.length; i++) {
    if (text[i] === '{' || text[i] === '[') depth++;
    else if (text[i] === '}' || text[i] === ']') depth--;
    if (depth === 0) { jsonEnd = i + 1; break; }
  }

  const data = JSON.parse(text.slice(jsonStart, jsonEnd));
  const stockData = data?.data;
  if (!stockData) return null;

  for (const key of Object.keys(stockData)) {
    const inner = stockData[key]?.data?.data;
    if (Array.isArray(inner) && inner.length > 0) {
      return inner.map((item: string) => {
        const parts = String(item).split(' ');
        return {
          time: parts[0],
          price: parseFloat(parts[1]) || 0,
          volume: parseInt(parts[2]) || 0,
          avgPrice: parseFloat(parts[1]) || 0,
        };
      });
    }
  }
  return null;
}

async function tryM5KLine(market: string, pureCode: string) {
  const param = `${market}${pureCode},m5,,,48,qfq`;
  const url = `http://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${param}`;

  const res = await fetch(url, {
    headers: { Referer: 'https://gu.qq.com' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return null;

  const json = await res.json();
  const key = `${market}${pureCode}`;
  const m5Data = json.data?.[key]?.m5 || json.data?.[key]?.qfqm5;

  if (!Array.isArray(m5Data) || m5Data.length === 0) return null;

  return m5Data.map((item: any) => {
    const ts = String(Array.isArray(item) ? item[0] : item);
    const time = ts.length >= 12 ? ts.slice(8, 12) : ts.slice(-4);
    const close = parseFloat(Array.isArray(item) ? (item[2] || 0) : (item.close || 0));
    return {
      time: time.padStart(4, '0'),
      price: close || 0,
      volume: Array.isArray(item) ? (parseInt(item[5]) || 0) : (parseInt(item.volume) || 0),
      avgPrice: close || 0,
    };
  });
}
