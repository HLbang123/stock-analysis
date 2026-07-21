/**
 * 口令 + 签名 cookie 认证（无状态，Web Crypto，edge/node 通用）
 * 有效期由 AUTH_MAX_AGE 环境变量控制（秒），默认 30 天。
 */

const SECRET = process.env.AUTH_SECRET || "dev-secret-change-me";
const MAX_AGE = parseInt(process.env.AUTH_MAX_AGE || "30") * 86400; // AUTH_MAX_AGE 单位：天，默认 30 天

export const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || "bang123";
export const AUTH_COOKIE = "auth";
export const AUTH_MAX_AGE = MAX_AGE;

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hmac(data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return toHex(sig);
}

/** 签发 token：exp 时间戳 + HMAC */
export async function signToken(): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE;
  return `${exp}.${await hmac(exp.toString())}`;
}

/** 校验 token：签名匹配 + 未过期 */
export async function verifyToken(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [expStr, sig] = parts;
  const exp = parseInt(expStr);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  return (await hmac(expStr)) === sig;
}
