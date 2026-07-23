import { NextRequest, NextResponse } from "next/server";
import { ACCESS_PASSWORD, AUTH_COOKIE, AUTH_MAX_AGE, signToken } from "@/lib/auth";

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: AUTH_MAX_AGE,
};

/** POST /api/auth — 验证口令，签发 cookie
 *  两种入口：
 *  - fetch JSON（正常 hydrate 的前端）：返回 JSON
 *  - 原生 form 提交（JS 未 hydrate 的兜底）：重定向，Set-Cookie 对整页导航生效
 */
export async function POST(request: NextRequest) {
  const contentType = request.headers.get("content-type") || "";

  // 原生 form 提交兜底（JS 未执行时）
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const form = await request.formData().catch(() => null);
    const password = (form?.get("password") as string) || "";
    if (password !== ACCESS_PASSWORD) {
      return NextResponse.redirect(new URL("/login?err=1", request.url));
    }
    const token = await signToken();
    const res = NextResponse.redirect(new URL("/", request.url));
    res.cookies.set(AUTH_COOKIE, token, COOKIE_OPTS);
    return res;
  }

  // fetch JSON 流程（正常前端）
  const { password } = await request.json().catch(() => ({} as any));
  if (password !== ACCESS_PASSWORD) {
    return NextResponse.json({ error: "口令错误" }, { status: 401 });
  }
  const token = await signToken();
  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, token, COOKIE_OPTS);
  return res;
}

/** DELETE /api/auth — 登出（清 cookie） */
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(AUTH_COOKIE);
  return res;
}
