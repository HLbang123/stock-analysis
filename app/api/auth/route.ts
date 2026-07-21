import { NextRequest, NextResponse } from "next/server";
import { ACCESS_PASSWORD, AUTH_COOKIE, AUTH_MAX_AGE, signToken } from "@/lib/auth";

/** POST /api/auth — 验证口令，签发 cookie */
export async function POST(request: NextRequest) {
  const { password } = await request.json().catch(() => ({} as any));
  if (password !== ACCESS_PASSWORD) {
    return NextResponse.json({ error: "口令错误" }, { status: 401 });
  }
  const token = await signToken();
  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: AUTH_MAX_AGE,
  });
  return res;
}

/** DELETE /api/auth — 登出（清 cookie） */
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(AUTH_COOKIE);
  return res;
}
