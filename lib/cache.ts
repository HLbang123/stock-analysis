/**
 * 数据缓存层 — TTL 双层过期 + 过期降级
 * 参考 FinGenius DataCacheManager (src/tool/create_html.py:37-160)
 *
 * 软过期（TTL）：数据返回但标记为 stale，调用方可选择是否重新获取
 * 硬过期（maxAge）：数据直接丢弃
 * 获取失败时返回软过期数据作为降级
 */

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;     // 软过期（毫秒）
  maxAge: number;  // 硬过期（毫秒）
}

// 数据类型 → TTL/maxAge 配置（毫秒）
const DEFAULT_TTL: Record<string, { ttl: number; maxAge: number }> = {
  quote:            { ttl: 30_000,    maxAge: 180_000 },   // 行情：30s/3min
  kline_daily:      { ttl: 300_000,   maxAge: 900_000 },   // 日K线：5min/15min
  minute_data:      { ttl: 120_000,   maxAge: 600_000 },   // 分时：2min/10min
  tushare_fundamental: { ttl: 600_000, maxAge: 3_600_000 }, // 基本面：10min/60min
  stock_list:       { ttl: 3_600_000, maxAge: 86_400_000 }, // 股票列表：60min/24h
  fuyao_anomaly:         { ttl: 30_000,  maxAge: 180_000 },  // 异动快照：30s/3min
  fuyao_limit_up:        { ttl: 30_000,  maxAge: 180_000 },  // 涨停池：30s/3min
  fuyao_limit_up_ladder: { ttl: 300_000, maxAge: 900_000 },  // 连板天梯：5min/15min
  fuyao_hot_stock:       { ttl: 60_000,  maxAge: 300_000 },  // 热股榜：1min/5min
  fuyao_skyrocket:       { ttl: 60_000,  maxAge: 300_000 },  // 飙升榜：1min/5min
  fuyao_dragon_tiger:    { ttl: 60_000,  maxAge: 600_000 },  // 龙虎榜：1min/10min
};

const cache = new Map<string, CacheEntry<any>>();

/**
 * 生成缓存 key
 */
function cacheKey(dataType: string, params: Record<string, any> = {}): string {
  const paramStr = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return paramStr ? `${dataType}:${paramStr}` : dataType;
}

/**
 * 从缓存获取数据
 * @returns { data, isStale } | null
 */
export function getCached<T>(dataType: string, params?: Record<string, any>): { data: T; isStale: boolean } | null {
  const key = cacheKey(dataType, params);
  const entry = cache.get(key);
  if (!entry) return null;

  const age = Date.now() - entry.timestamp;
  if (age > entry.maxAge) {
    return null;
  }

  return { data: entry.data as T, isStale: age > entry.ttl };
}

/**
 * 存入缓存
 */
export function setCache<T>(dataType: string, data: T, params?: Record<string, any>, ttl?: number, maxAge?: number): void {
  const key = cacheKey(dataType, params);
  const config = DEFAULT_TTL[dataType] || { ttl: 600_000, maxAge: 3_600_000 };
  cache.set(key, {
    data,
    timestamp: Date.now(),
    ttl: ttl || config.ttl,
    maxAge: maxAge || config.maxAge,
  });
}

/**
 * 清理所有硬过期缓存
 */
export function cleanupExpired(): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.timestamp > entry.maxAge) {
      cache.delete(key);
    }
  }
}

// 每 5 分钟自动清理一次（unref：清理定时器不阻止 CLI 脚本/一次性进程正常退出）
if (typeof setInterval !== 'undefined') {
  const timer = setInterval(cleanupExpired, 300_000);
  if (timer && typeof (timer as any).unref === 'function') (timer as any).unref();
}
