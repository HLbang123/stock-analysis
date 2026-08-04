/**
 * 统一 API 请求层 — 收敛项目里三套并行的请求方式。
 *
 * 现状问题：
 *  1. services/stockApi.ts 只封装了少数接口（quote/kline/minute/chip）
 *  2. 页面里大量裸 fetch('/api/...')（market 8 个、stock 详情 4 个、ai 5 个）
 *  3. 错误处理四套并行：静默 catch / toast / alert / 内联错误 div
 *
 * 约定：
 *  - 业务数据请求统一走 getJSON / postJSON
 *  - 响应含 { error } 视为失败，抛错由调用方 catch
 *  - 错误提示统一由调用方决定（默认静默，需要时 toast.error）
 *  - 可降级的数据源（行情/筹码等）仍允许静默降级，但要在调用点注释说明
 */

export class ApiError extends Error {
  constructor(message: string, public status?: number, public data?: any) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (e: any) {
    throw new ApiError(e?.message || '网络请求失败', 0);
  }

  let data: any;
  try {
    data = await res.json();
  } catch {
    throw new ApiError(`响应解析失败 (HTTP ${res.status})`, res.status);
  }

  if (!res.ok) {
    throw new ApiError(data?.error || `请求失败 (HTTP ${res.status})`, res.status, data);
  }
  // 业务错误：{ error: '...' } 结构
  if (data && typeof data === 'object' && 'error' in data && data.error) {
    throw new ApiError(data.error, res.status, data);
  }
  return data as T;
}

/** GET JSON。T 为响应数据类型；失败抛 ApiError */
export function getJSON<T = any>(path: string, init?: RequestInit): Promise<T> {
  return request<T>(path, { method: 'GET', ...init });
}

/** POST JSON。body 自动 JSON.stringify */
export function postJSON<T = any>(path: string, body?: any, init?: RequestInit): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    body: body == null ? undefined : JSON.stringify(body),
    ...init,
  });
}

/**
 * 安全版 getJSON — 失败返回 fallback 而非抛错。
 * 用于可降级的数据源（行情、筹码、榜单等）：拿不到就用默认值继续渲染。
 */
export async function getJSONOr<T>(path: string, fallback: T, init?: RequestInit): Promise<T> {
  try {
    return await getJSON<T>(path, init);
  } catch {
    return fallback;
  }
}
