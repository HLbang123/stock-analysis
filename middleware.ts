import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE, verifyToken } from "@/lib/auth";

// 公开路径：登录页 + 登录接口
const PUBLIC_PATHS = ["/login", "/api/auth"];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // 公开路径放行
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next();
  }

  // 已登录放行
  const token = request.cookies.get(AUTH_COOKIE)?.value;
  if (await verifyToken(token)) return NextResponse.next();

  // 未登录：API 返回 401，页面跳 /login
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "未授权，请先登录" }, { status: 401 });
  }
  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // 排除静态资源与公开数据文件，其余全过 middleware
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|manifest.json|icon-.*|stocks.json|robots.txt).*)",
  ],
};
