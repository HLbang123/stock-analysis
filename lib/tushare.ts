/**
 * Tushare API 客户端（服务端专用）
 * Token 从 .env.local 读取，绝不暴露给前端
 *
 * Tushare API 文档：https://tushare.pro/document/2
 */

const TUSHARE_API = "https://api.tushare.pro";

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
  // ETF/基金：5 开头
  if (code.startsWith("5")) {
    // 上交所 ETF：51xxxx, 58xxxx
    if (code.startsWith("51") || code.startsWith("58")) return `${code}.SH`;
    // 深交所 ETF：159xxx, 16xxxx(LOF)
    return `${code}.SZ`;
  }
  // 深交所：000xxx, 001xxx, 002xxx, 003xxx, 300xxx, 301xxx
  if (
    code.startsWith("000") ||
    code.startsWith("001") ||
    code.startsWith("002") ||
    code.startsWith("003") ||
    code.startsWith("300") ||
    code.startsWith("301")
  ) {
    return `${code}.SZ`;
  }
  // 上交所：600xxx, 601xxx, 603xxx, 605xxx, 688xxx
  if (
    code.startsWith("600") ||
    code.startsWith("601") ||
    code.startsWith("603") ||
    code.startsWith("605") ||
    code.startsWith("688")
  ) {
    return `${code}.SH`;
  }
  // 北交所
  if (code.startsWith("4") || code.startsWith("8")) {
    return `${code}.BJ`;
  }
  // 默认上交所
  return `${code}.SH`;
}

/**
 * 调用 Tushare API
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

  const response = await fetch(TUSHARE_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Tushare API HTTP ${response.status}`);
  }

  const json: TushareResponse<T> = await response.json();

  if (json.code !== 0) {
    throw new Error(`Tushare 错误 [${json.code}]: ${json.msg}`);
  }

  return json;
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
