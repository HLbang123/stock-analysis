/**
 * LLM 低并发自适应限流器（客户端）。
 *
 * 背景：免费档模型（如 glm-4.7-flash 免费版 1 QPS / 1 并发）在深度分析波1的 4 路并发下
 * 会直接 429 报错，导致辩手大片跳过、只剩降级裁决。
 *
 * 策略：默认放行 4 路并发；某 key（baseUrl+model+key尾）一旦返回 429，即学到"1 并发"，
 * 后续调用经内存信号量串行排队，并持久化到 localStorage——下次分析直接串行起步。
 * 把"并发打爆 → 角色跳过"降级为"只是变慢"。付费用户永不触发 429，零影响。
 */

const DEFAULT_CAP = 4; // 深度分析波1最大并发数
const LS_KEY = 'llm-low-concurrency-keys';

interface Entry {
  cap: number;
  active: number;
  queue: (() => void)[];
}

const entries = new Map<string, Entry>();
let hydrated = false;

/** 从 localStorage 恢复已学到的低并发 key（SSR/隐私模式失败则仅靠内存学习） */
function hydrate() {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw) as Record<string, number>;
    for (const [k, cap] of Object.entries(obj)) {
      if (cap >= 1 && cap < DEFAULT_CAP) entries.set(k, { cap, active: 0, queue: [] });
    }
  } catch { /* ignore */ }
}

function entryFor(key: string): Entry {
  hydrate();
  let e = entries.get(key);
  if (!e) {
    e = { cap: DEFAULT_CAP, active: 0, queue: [] };
    entries.set(key, e);
  }
  return e;
}

/** 取一个并发槽（满则排队等待）。返回幂等的释放函数。 */
export async function acquireLlmSlot(key: string): Promise<() => void> {
  const e = entryFor(key);
  if (e.active >= e.cap) {
    await new Promise<void>((res) => e.queue.push(res)); // 被唤醒时槽位已由释放方移交
  } else {
    e.active++;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = e.queue.shift();
    if (next) next(); // 槽位移交给等待者，active 不变
    else e.active--;
  };
}

/** 学到 429：该 key 降到 1 并发并持久化。返回是否首次学到（供 UI 提示一次）。 */
export function noteLlmRateLimited(key: string): boolean {
  const e = entryFor(key);
  if (e.cap === 1) return false;
  e.cap = 1;
  try {
    const raw = localStorage.getItem(LS_KEY);
    const obj = raw ? (JSON.parse(raw) as Record<string, number>) : {};
    obj[key] = 1;
    localStorage.setItem(LS_KEY, JSON.stringify(obj));
  } catch { /* ignore */ }
  return true;
}
