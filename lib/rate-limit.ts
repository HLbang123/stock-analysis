/**
 * 简单内存限流（PM2 单进程，够用；进程重启即清零，无副作用）
 * 用法：if (!rateLimit(`sync:get:${clientIp(req)}`, 60, 60_000)) return 429
 */

const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const cur = buckets.get(key);
  if (!cur || cur.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  cur.count++;
  return cur.count <= limit;
}

/** 客户端 IP（nginx 反代后取 x-forwarded-for 首段） */
export function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim() || 'unknown';
  return 'unknown';
}
