/**
 * 数据源 fallback 编排器
 *
 * 把 quote / kline 路由里"腾讯 → 新浪"的内联 fallback 收敛成统一注册表，
 * 加上：第 3 源（东方财富）、hedged 降级（慢源 softTimeout 后并发起下一个，不干等）、
 * 健康熔断（某源连续失败 3 次暂封 60s，避免每次都先试已挂的源）。
 *
 * 注意：这只治"服务器 → 数据源"这一段的健壮性，不治用户访问服务器的 SNI 封锁（那是 CF 的活）。
 */

export interface Source<T> {
  id: string;
  /** 取数；signal 由编排器注入（含 hardTimeout）。返回 null 表示该源无数据，由编排器降级。 */
  fetch: (signal: AbortSignal) => Promise<T | null>;
}

interface Health {
  fails: number;
  blockedUntil: number;
}

const FAIL_THRESHOLD = 3;
const BLOCK_MS = 60_000;

const health = new Map<string, Health>();

function isBlocked(id: string): boolean {
  const h = health.get(id);
  return !!h && h.blockedUntil > Date.now();
}

function recordSuccess(id: string): void {
  health.delete(id);
}

function recordFailure(id: string): void {
  const h = health.get(id) ?? { fails: 0, blockedUntil: 0 };
  h.fails += 1;
  if (h.fails >= FAIL_THRESHOLD) {
    h.blockedUntil = Date.now() + BLOCK_MS;
    h.fails = 0; // 封禁后清零，解封后重新计数
    console.warn(`[data-sources] ${id} 连续失败 ${FAIL_THRESHOLD} 次，熔断 ${BLOCK_MS / 1000}s`);
  }
  health.set(id, h);
}

/**
 * Hedged fallback：立即启动第一个源；softTimeout 内未拿到结果就并发启动下一个；
 * 任一源返回非 null 即采用并 abort 其余；某源失败则立即启动下一个未启动的（fail-fast）。
 * 全部失败/超时返回 null，并对失败源计健康分。
 */
export async function withFallback<T>(
  sources: Source<T>[],
  opts: { softTimeout?: number; hardTimeout?: number } = {}
): Promise<T | null> {
  const { softTimeout = 3000, hardTimeout = 8000 } = opts;
  if (sources.length === 0) return null;

  // 过滤被熔断的源；全被熔断则降级用全部（总比直接失败强）
  const healthy = sources.filter(s => !isBlocked(s.id));
  const candidates = healthy.length > 0 ? healthy : sources;

  const controllers: AbortController[] = [];
  const hedgeTimers: ReturnType<typeof setTimeout>[] = [];
  const started = new Set<number>();
  let settledCount = 0;
  let done = false;

  return new Promise<T | null>((resolve) => {
    const finish = (val: T | null) => {
      if (done) return;
      done = true;
      controllers.forEach(c => { try { c.abort(); } catch { /* 已关闭 */ } });
      hedgeTimers.forEach(t => clearTimeout(t));
      resolve(val);
    };

    const launchNext = () => {
      for (let i = 0; i < candidates.length; i++) {
        if (!started.has(i)) { launch(i); break; }
      }
    };

    const launch = (idx: number) => {
      if (done || started.has(idx) || idx >= candidates.length) return;
      started.add(idx);
      const src = candidates[idx];
      const ac = new AbortController();
      controllers.push(ac);
      const hardTimer = setTimeout(() => ac.abort(), hardTimeout);

      src.fetch(ac.signal)
        .then(res => {
          clearTimeout(hardTimer);
          if (done) return;
          if (res != null) {
            recordSuccess(src.id);
            finish(res);
          } else {
            settledCount++;
            recordFailure(src.id);
            if (settledCount >= candidates.length) finish(null);
            else launchNext();
          }
        })
        .catch(() => {
          clearTimeout(hardTimer);
          if (done) return;
          settledCount++;
          recordFailure(src.id);
          if (settledCount >= candidates.length) finish(null);
          else launchNext();
        });
    };

    launch(0);
    for (let i = 1; i < candidates.length; i++) {
      hedgeTimers.push(setTimeout(() => launch(i), softTimeout * i));
    }
  });
}
