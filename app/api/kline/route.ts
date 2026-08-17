import { NextRequest, NextResponse } from 'next/server';
import { withFallback } from '@/lib/data-sources/registry';
import { fetchTencentKLine } from '@/lib/data-sources/kline/tencent';
import { fetchSinaKLine } from '@/lib/data-sources/kline/sina';
import { fetchEastmoneyKLine } from '@/lib/data-sources/kline/eastmoney';

// 短 TTL 缓存 + 在途去重（同 /api/minute 模式）：多人同时看同一只票的详情/AI 页时
// 只产生一份上游请求。日K盘中会随今日 bar 变化，TTL 60s；60s~10min 拉空降级陈旧缓存。
const KLINE_TTL = 60_000;
const KLINE_MAX_AGE = 600_000;
const klineCache = new Map<string, { data: any[]; ts: number }>();
const klineInflight = new Map<string, Promise<any[]>>();

/**
 * K线数据代理 — 腾讯→东方财富→新浪，hedged 降级（慢源 3s 后并发）+ 健康熔断
 * 腾讯/东方财富为前复权日K（成交量:手）；新浪用 scale 参数（成交量由股归一化为手）
 */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  const days = parseInt(request.nextUrl.searchParams.get('days') || '120');
  const scale = parseInt(request.nextUrl.searchParams.get('scale') || '240');

  if (!code) {
    return NextResponse.json({ error: '缺少 code 参数' }, { status: 400 });
  }

  try {
    const klines = await getKLineCached(code, days, scale);
    return NextResponse.json(klines);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

async function getKLineCached(code: string, days: number, scale: number): Promise<any[]> {
  const key = `${code}:${days}:${scale}`;
  const now = Date.now();

  const entry = klineCache.get(key);
  if (entry && now - entry.ts < KLINE_TTL) return entry.data;

  const existing = klineInflight.get(key);
  if (existing) return existing;

  const p = (async () => {
    const fresh = await withFallback([
      { id: 'tencent',   fetch: (s) => fetchTencentKLine(code, days, s) },
      { id: 'eastmoney', fetch: (s) => fetchEastmoneyKLine(code, days, s) },
      { id: 'sina',      fetch: (s) => fetchSinaKLine(code, scale, days, s) },
    ]);
    if (fresh && fresh.length > 0) {
      if (klineCache.size > 2000) klineCache.clear(); // 超帽整体清
      klineCache.set(key, { data: fresh, ts: Date.now() });
      return fresh;
    }
    if (entry && now - entry.ts < KLINE_MAX_AGE) return entry.data;
    return fresh ?? [];
  })().finally(() => klineInflight.delete(key));

  klineInflight.set(key, p);
  return p;
}
