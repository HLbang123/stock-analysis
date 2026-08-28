import type { AuthTier } from "@/lib/auth";

const AUTH_TIER_COOKIE = "auth_tier";
const AUTH_EXP_COOKIE = "auth_exp";

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
}

export interface AuthInfo {
  tier: AuthTier;
  /** 过期时间戳（秒）；旧登录态无此 cookie 时为 null */
  expSec: number | null;
}

/**
 * 客户端读取登录档位与过期时间。
 * 这里只是 UI 展示/门禁用，真正的权限校验在服务端（AUTH_COOKIE 签名）。
 */
export function getAuthInfo(): AuthInfo {
  const tier: AuthTier = readCookie(AUTH_TIER_COOKIE) === "advanced" ? "advanced" : "basic";
  const raw = readCookie(AUTH_EXP_COOKIE);
  const expSec = raw && /^\d+$/.test(raw) ? parseInt(raw, 10) : null;
  return { tier, expSec };
}

export function getClientTier(): AuthTier {
  return getAuthInfo().tier;
}

/** 剩余有效天数（向上取整）；无过期信息返回 null，已过期返回 0 */
export function remainingDays(expSec: number | null): number | null {
  if (expSec == null) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  const left = expSec - nowSec;
  if (left <= 0) return 0;
  return Math.ceil(left / 86400);
}