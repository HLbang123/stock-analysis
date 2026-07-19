/**
 * Tushare API 客户端（服务端专用）
 * Token 从 .env.local 读取，绝不暴露给前端
 *
 * Tushare API 文档：https://tushare.pro/document/2
 *
 * 反封禁策略（参考 nt_project ETL 工程实践）：
 * - 请求间隔 ≥ 200ms（免费版限 ~200次/分钟）
 * - 瞬态错误指数退避重试（最多 3 次）
 * - 同类错误冷却 60s（避免重复告警刷屏）
 */

// tsx 脚本不会自动加载 .env.local，手动加载
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const TUSHARE_API = "https://api.tushare.pro";
const MIN_REQUEST_INTERVAL = 350; // ms，两次请求最小间隔（~170次/分钟，Tushare 限制 300次/min）
const MAX_RETRIES = 3;
const ERROR_COOLDOWN_MS = 60000; // 同类错误冷却 60s

interface TushareRequest {
  api_name: string;
  token: string;
  params?: Record<string, any>;
  fields?: string;
}

interface TushareResponse<T = any> {
  code: number;
  msg: string;
  data?: {
    fields: string[];
    items: T[][];
    has_more?: boolean;
  };
}

/**
 * 将用户代码转换为 Tushare ts_code 格式
 * 000001 → 000001.SZ, 600000 → 600000.SH
 */
export function toTsCode(code: string): string {
  // 先去掉可能存在的 sh/sz/bj 前缀
  const pure = code.replace(/^(sh|sz|bj)/i, '');
  // ETF/基金：5 开头
  if (pure.startsWith("5")) {
    // 上交所 ETF：51xxxx, 58xxxx
    if (pure.startsWith("51") || pure.startsWith("58")) return `${pure}.SH`;
    // 深交所 ETF：159xxx, 16xxxx(LOF)
    return `${pure}.SZ`;
  }
  // 深交所：000xxx, 001xxx, 002xxx, 003xxx, 300xxx, 301xxx
  if (
    pure.startsWith("000") ||
    pure.startsWith("001") ||
    pure.startsWith("002") ||
    pure.startsWith("003") ||
    pure.startsWith("300") ||
    pure.startsWith("301")
  ) {
    return `${pure}.SZ`;
  }
  // 上交所：600xxx, 601xxx, 603xxx, 605xxx, 688xxx
  if (
    pure.startsWith("600") ||
    pure.startsWith("601") ||
    pure.startsWith("603") ||
    pure.startsWith("605") ||
    pure.startsWith("688")
  ) {
    return `${pure}.SH`;
  }
  // 北交所
  if (pure.startsWith("4") || pure.startsWith("8")) {
    return `${pure}.BJ`;
  }
  // 默认上交所
  return `${pure}.SH`;
}

// ===== 反封禁：速率控制 + 重试 + 错误冷却 =====

let lastRequestTime = 0;
const errorCooldowns = new Map<string, number>();

/**
 * 确保请求间隔不低于 MIN_REQUEST_INTERVAL
 */
async function throttle(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_REQUEST_INTERVAL) {
    await new Promise(r => setTimeout(r, MIN_REQUEST_INTERVAL - elapsed));
  }
  lastRequestTime = Date.now();
}

/**
 * 检查该类错误是否在冷却期内（避免同一错误反复刷日志）
 * 返回 true 表示已冷却/可跳过告警
 */
function isErrorCooldownActive(key: string): boolean {
  const cooldownUntil = errorCooldowns.get(key);
  if (cooldownUntil && Date.now() < cooldownUntil) return true;
  errorCooldowns.set(key, Date.now() + ERROR_COOLDOWN_MS);
  return false;
}

/**
 * 调用 Tushare API（带重试和速率控制）
 */
export async function callTushare<T = any>(
  apiName: string,
  params?: Record<string, any>,
  fields?: string
): Promise<TushareResponse<T>> {
  const token = process.env.TUSHARE_TOKEN;

  if (!token) {
    throw new Error("TUSHARE_TOKEN 未配置，请在 .env.local 中设置");
  }

  const body: TushareRequest = {
    api_name: apiName,
    token,
    params,
    fields,
  };

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        // 指数退避: 1s, 2s, 4s
        const delay = Math.pow(2, attempt - 1) * 1000;
        await new Promise(r => setTimeout(r, delay));
      }

      await throttle();

      const response = await fetch(TUSHARE_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        // HTTP 429/5xx → 可重试
        if (response.status === 429 || response.status >= 500) {
          throw new Error(`Tushare HTTP ${response.status} (attempt ${attempt + 1}/${MAX_RETRIES + 1})`);
        }
        throw new Error(`Tushare API HTTP ${response.status}`);
      }

      const json: TushareResponse<T> = await response.json();

      if (json.code !== 0) {
        // 业务错误不重试（如参数错误、权限不足）
        throw new Error(`Tushare 错误 [${json.code}]: ${json.msg}`);
      }

      return json;
    } catch (e: any) {
      lastError = e;
      const isRetryable =
        e.message?.includes('HTTP 429') ||
        e.message?.includes('HTTP 5') ||
        e.message?.includes('attempt') ||
        e.message?.includes('fetch failed') ||
        e.message?.includes('network');

      if (!isRetryable || attempt === MAX_RETRIES) break;
    }
  }

  const errKey = `tushare:${apiName}`;
  if (!isErrorCooldownActive(errKey)) {
    console.error(`[Tushare] ${apiName} 请求失败（已重试${MAX_RETRIES}次）: ${lastError?.message}`);
  }

  throw lastError ?? new Error(`Tushare ${apiName} 请求失败`);
}

// ===== 交易日历缓存 =====

const tradeCalCache: Map<string, boolean> = new Map();

/**
 * 获取某个月份的交易日列表（缓存全年）
 * trade_cal 接口为公开接口，不需要额外积分
 */
export async function fetchTradeCal(year?: number): Promise<Set<string>> {
  const y = year ?? new Date().getFullYear();
  const cacheStart = `${y}0101`;

  // 如果该年已缓存，直接返回
  if (tradeCalCache.size > 0 && tradeCalCache.has(cacheStart)) {
    return new Set(
      Array.from(tradeCalCache.entries())
        .filter(([, v]) => v)
        .map(([k]) => k)
    );
  }

  try {
    const res = await callTushare('trade_cal', {
      exchange: 'SSE',
      start_date: `${y}0101`,
      end_date: `${y}1231`,
    }, 'cal_date,is_open');

    tradeCalCache.clear();
    const tradingDays = new Set<string>();
    for (const item of toRecords<{ cal_date: string; is_open: number }>(res)) {
      const isTrade = item.is_open === 1;
      tradeCalCache.set(item.cal_date, isTrade);
      if (isTrade) tradingDays.add(item.cal_date);
    }
    // 标记已缓存
    tradeCalCache.set(cacheStart, true);
    return tradingDays;
  } catch {
    // 获取失败时降级：返回空 Set，调用方回退到周末判断
    return new Set();
  }
}

/**
 * 检查指定日期是否为交易日
 */
export async function isTradeDay(dateStr?: string): Promise<boolean> {
  const ds = dateStr ?? new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const days = await fetchTradeCal();
  if (days.size === 0) {
    // 降级：仅过滤周末
    const d = new Date(parseInt(ds.slice(0, 4)), parseInt(ds.slice(4, 6)) - 1, parseInt(ds.slice(6, 8)));
    return d.getDay() !== 0 && d.getDay() !== 6;
  }
  return days.has(ds);
}

/**
 * 将 Tushare 返回的二维数组转换为对象数组
 */
export function toRecords<T extends Record<string, any>>(
  response: TushareResponse
): T[] {
  if (!response.data?.fields || !response.data?.items) return [];
  const { fields, items } = response.data;
  return items.map((row) => {
    const record: any = {};
    fields.forEach((field, i) => {
      record[field] = row[i];
    });
    return record as T;
  });
}
