/**
 * 服务端实时行情缓存（quote / quotes 两路由共用，进程内单例）
 *
 * 背景（2026-08-17）：自选含 400+ 标的的用户增多后，前端逐只请求 /api/quote，
 * 服务端零缓存直连上游（hedged 降级还会并发打 3 源），N 用户 × 400 只 → 数千并发
 * 出站请求打满 2 核事件循环，全站间歇性卡死。
 *
 * 对策：
 * - 批量主路：腾讯多代码单请求（50 只/块），400 只 ≈ 8 次上游请求
 * - 5s 短 TTL + 在途去重：N 个用户同时刷同一批票只产生一份上游请求
 * - 批量未覆盖的代码（腾讯不支持的品种）回落单码三源 hedged（并发 8 限流）
 * - 上游全挂时降级 60s 内陈旧缓存，优于直接报错
 */
import { RealtimeQuote } from '@/types';
import { withFallback } from '@/lib/data-sources/registry';
import { fetchTencentQuote, fetchTencentBatchQuotes } from '@/lib/data-sources/quote/tencent';
import { fetchSinaQuote } from '@/lib/data-sources/quote/sina';
import { fetchEastmoneyQuote } from '@/lib/data-sources/quote/eastmoney';

const TTL = 5_000;
const MAX_AGE = 60_000;
const CACHE_CAP = 5000;
const BATCH_CHUNK = 50;
const FALLBACK_CONCURRENCY = 8;

const cache = new Map<string, { quote: RealtimeQuote; ts: number }>();
const inflight = new Map<string, Promise<RealtimeQuote | null>>();

function store(code: string, quote: RealtimeQuote): void {
  if (cache.size >= CACHE_CAP) {
    const now = Date.now();
    for (const [k, v] of cache) if (now - v.ts > MAX_AGE) cache.delete(k);
    // 仍超帽（极端）：清最旧的一批
    if (cache.size >= CACHE_CAP) {
      let n = Math.ceil(CACHE_CAP / 10);
      for (const k of cache.keys()) { cache.delete(k); if (--n <= 0) break; }
    }
  }
  cache.set(code, { quote, ts: Date.now() });
}

function staleOf(code: string): RealtimeQuote | null {
  const hit = cache.get(code);
  return hit && Date.now() - hit.ts < MAX_AGE ? hit.quote : null;
}

/** 单码三源 hedged 降级（原 /api/quote 的行为，抽出来供批量兜底复用） */
function fetchSingle(code: string): Promise<RealtimeQuote | null> {
  return withFallback([
    { id: 'tencent', fetch: (s) => fetchTencentQuote(code, s) },
    { id: 'sina', fetch: (s) => fetchSinaQuote(code, s) },
    { id: 'eastmoney', fetch: (s) => fetchEastmoneyQuote(code, s) },
  ]);
}

/** 单码实时行情（5s 缓存 + 在途去重 + 陈旧降级）。code 为已归一化的 symbol（sh600519） */
export async function getQuoteCached(code: string): Promise<RealtimeQuote | null> {
  const hit = cache.get(code);
  if (hit && Date.now() - hit.ts < TTL) return hit.quote;

  const pending = inflight.get(code);
  if (pending) return pending;

  const p = (async () => {
    const fresh = await fetchSingle(code);
    if (fresh) { store(code, fresh); return fresh; }
    return staleOf(code);
  })().finally(() => inflight.delete(code));
  inflight.set(code, p);
  return p;
}

/** 简单并发池 */
async function pool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) await fn(items[idx++]);
  }));
}

/**
 * 批量实时行情：腾讯多代码主路 + 单码三源兜底。
 * 输入已归一化 symbol 列表；返回 code → quote 的映射（缺失即失败，调用方按 null 处理）。
 */
export async function getQuotesBatch(codes: string[]): Promise<Map<string, RealtimeQuote>> {
  const out = new Map<string, RealtimeQuote>();
  const need: string[] = [];
  const waiters: Promise<unknown>[] = [];

  for (const code of codes) {
    const hit = cache.get(code);
    if (hit && Date.now() - hit.ts < TTL) { out.set(code, hit.quote); continue; }
    const pending = inflight.get(code);
    if (pending) { waiters.push(pending.then((q) => { if (q) out.set(code, q); })); continue; }
    need.push(code);
  }

  // 主路：腾讯批量（50/块），块内每码登记 inflight 供并发请求去重
  const stragglers: string[] = [];
  await Promise.all(
    Array.from({ length: Math.ceil(need.length / BATCH_CHUNK) }, (_, i) => need.slice(i * BATCH_CHUNK, (i + 1) * BATCH_CHUNK))
      .map(async (chunk) => {
        const p = (async () => (await fetchTencentBatchQuotes(chunk, AbortSignal.timeout(8000))) ?? new Map<string, RealtimeQuote>())();
        for (const c of chunk) inflight.set(c, p.then((m) => m.get(c) ?? null));
        const found = await p;
        for (const c of chunk) {
          inflight.delete(c);
          const q = found.get(c);
          if (q) { store(c, q); out.set(c, q); } else stragglers.push(c);
        }
      })
  );

  // 兜底：批量没返回的代码走单码三源（限流并发，正常为 0~个位数）
  await pool(stragglers, FALLBACK_CONCURRENCY, async (c) => {
    const q = await fetchSingle(c);
    if (q) { store(c, q); out.set(c, q); return; }
    const stale = staleOf(c);
    if (stale) out.set(c, stale);
  });

  await Promise.all(waiters);
  return out;
}
