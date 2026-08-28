/**
 * 口令 + 签名 cookie 认证（无状态，Web Crypto，edge/node 通用）
 * 有效期由 AUTH_MAX_AGE 环境变量控制（秒），默认 30 天。
 *
 * 支持两种口令档位：
 *  - ACCESS_PASSWORD            普通口令 → tier 'basic'（默认，无超短线）
 *  - ACCESS_ADVANCED_PASSWORD   专用口令 → tier 'advanced'（解锁超短线三套策略）
 * 未配置 ACCESS_ADVANCED_PASSWORD 时，所有登录用户均为 basic（超短线关闭）。
 */

const SECRET = process.env.AUTH_SECRET || "dev-secret-change-me";
const MAX_AGE = parseInt(process.env.AUTH_MAX_AGE || "30") * 86400; // AUTH_MAX_AGE 单位：天，默认 30 天

export const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || "bang123";
export const ACCESS_ADVANCED_PASSWORD = process.env.ACCESS_ADVANCED_PASSWORD || "";
export const AUTH_COOKIE = "auth";
/** 供前端读取当前档位的非 HttpOnly cookie（真实鉴权仍以 AUTH_COOKIE 内签名为准） */
export const AUTH_TIER_COOKIE = "auth_tier";
/** 供前端读取过期时间戳（秒）的非 HttpOnly cookie */
export const AUTH_EXP_COOKIE = "auth_exp";
export const AUTH_MAX_AGE = MAX_AGE;

export type AuthTier = "basic" | "advanced";

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

/** 口令 → 档位；无效口令返回 null */
export function resolveTier(password: string): AuthTier | null {
  if (ACCESS_ADVANCED_PASSWORD && password === ACCESS_ADVANCED_PASSWORD) return "advanced";
  if (password === ACCESS_PASSWORD) return "basic";
  return null;
}

export interface SignedToken {
  token: string;
  /** 过期时间戳（秒） */
  exp: number;
}

/** 签发 token：tier.exp 时间戳 + HMAC（格式 tier.exp.sig） */
export async function signToken(tier: AuthTier = "basic"): Promise<SignedToken> {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE;
  const body = tier + "." + exp;
  const token = body + "." + (await hmac(body));
  return { token, exp };
}

interface ParsedToken {
  tier: AuthTier;
  exp: number;
}

/** 解析/校验 token；兼容旧版 2 段格式 exp.sig（视为 basic） */
async function parseToken(token: string | undefined): Promise<ParsedToken | null> {
  if (!token) return null;
  const parts = token.split(".");
  let tier: AuthTier = "basic";
  let expStr: string;
  let body: string;

  if (parts.length === 3) {
    tier = parts[0] as AuthTier;
    expStr = parts[1];
    body = tier + "." + expStr;
    if (tier !== "basic" && tier !== "advanced") return null;
    if ((await hmac(body)) !== parts[2]) return null;
  } else if (parts.length === 2) {
    expStr = parts[0];
    body = expStr;
    if ((await hmac(body)) !== parts[1]) return null;
    tier = "basic";
  } else {
    return null;
  }

  const exp = parseInt(expStr);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return null;
  return { tier, exp };
}

/** 校验 token：签名匹配 + 未过期 */
export async function verifyToken(token: string | undefined): Promise<boolean> {
  return (await parseToken(token)) !== null;
}

/** 读取 token 携带的档位；无效/过期返回 null */
export async function getTokenTier(token: string | undefined): Promise<AuthTier | null> {
  const p = await parseToken(token);
  return p ? p.tier : null;
}