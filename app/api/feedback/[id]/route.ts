import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

/**
 * 单条反馈详情 + 状态更新。
 * GET    /api/feedback/[id] — 返回完整内容与截图（data URL 数组）
 * PATCH  /api/feedback/[id] — body { status: 'new' | 'processing' | 'resolved' }
 */

const VALID_STATUS = ['new', 'processing', 'resolved'];

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const item = await prisma.feedback.findUnique({ where: { id } });
    if (!item) {
      return NextResponse.json({ error: '反馈不存在' }, { status: 404 });
    }
    return NextResponse.json({ item });
  } catch (e) {
    console.error('[api/feedback/[id] GET]', e);
    return NextResponse.json({ error: '查询失败' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as { status?: unknown } | null;
  const status = body?.status;
  if (typeof status !== 'string' || !VALID_STATUS.includes(status)) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }
  try {
    await prisma.feedback.update({
      where: { id },
      data: { status },
    });
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'code' in e && (e as { code?: string }).code === 'P2025') {
      return NextResponse.json({ error: '反馈不存在' }, { status: 404 });
    }
    console.error('[api/feedback/[id] PATCH]', e);
    return NextResponse.json({ error: '更新失败' }, { status: 500 });
  }
}
