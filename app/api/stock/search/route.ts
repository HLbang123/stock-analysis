import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

/**
 * GET /api/stock/search?keyword=xxx — 按名称/代码搜标的（AI 对话工具 search_stock 用）
 * 镜像 chat-tools.ts search_stock 的 SQL：is_active 标的中模糊匹配，最多 5 条。
 * 返回 { items: [{ ts_code, name, industry }] }；无结果 items 为空数组。
 */
export async function GET(request: NextRequest) {
  const keyword = request.nextUrl.searchParams.get('keyword');
  if (!keyword) {
    return NextResponse.json({ error: '缺少 keyword 参数' }, { status: 400 });
  }
  try {
    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT ts_code, name, industry FROM stocks WHERE (name LIKE $1 OR ts_code LIKE $1) AND is_active = true LIMIT 5`,
      `%${keyword}%`
    );
    return NextResponse.json({ items: rows });
  } catch (e: any) {
    return NextResponse.json({ error: e.message?.slice(0, 120) }, { status: 500 });
  }
}
