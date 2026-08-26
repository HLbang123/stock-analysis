/**
 * 简单内存限流（PM2 单进程，够用；进程重启即清零，无副作用）
 * 用法：if (!rateLimit(`sync:get:${clientIp(req)}`, 60, 60_000)) return 429
 */

const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  // 长跑进程兜底：Map 只增不减会缓慢漏内存，超过阈值清一遍过期桶
  if (buckets.size > 10_000) {
    for (const [k, v] of buckets) {
      if (v.resetAt < now) buckets.delete(k);
    }
  }
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
  // nginx 用 $proxy_add_x_forwarded_for 会把真实 remote_addr 追加在最后；
  // 客户端可伪造 XFF 首段，所以取最后一段而不是首段，避免靠伪造 XFF 绕过限流。
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return 'unknown';
}
