import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { clientIp, rateLimit } from '@/lib/rate-limit';

/**
 * 意见反馈 API
 * POST multipart/form-data
 *   content: 反馈内容（必填，≤2000 字）
 *   contact: 联系方式（选填，≤80 字）
 *   images:  截图（选填，最多 3 张，image/*，单张 ≤5MB）
 *   path:    提交时所在页面（客户端透传）
 * GET  ?limit&offset — 反馈列表（不含图片二进制，仅返回截图数量）
 */

const MAX_CONTENT = 2000;
const MAX_CONTACT = 80;
const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const str = (v: FormDataEntryValue | null): string => (typeof v === 'string' ? v.trim() : '');

interface FeedbackListItem {
  id: string;
  content: string;
  contact: string | null;
  path: string | null;
  imageCount: number;
  status: string;
  createdAt: Date;
}

export async function POST(request: NextRequest) {
  if (!rateLimit(`feedback:post:${clientIp(request)}`, 5, 60_000)) {
    return NextResponse.json({ error: '提交过于频繁，请稍后再试' }, { status: 429 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  const content = str(form.get('content'));
  if (!content) {
    return NextResponse.json({ error: '请填写反馈内容' }, { status: 400 });
  }
  if (content.length > MAX_CONTENT) {
    return NextResponse.json({ error: '反馈内容过长' }, { status: 400 });
  }
  const contact = str(form.get('contact')).slice(0, MAX_CONTACT);

  const files = form.getAll('images').filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length > MAX_IMAGES) {
    return NextResponse.json({ error: `最多上传 ${MAX_IMAGES} 张图片` }, { status: 400 });
  }

  const images: string[] = [];
  for (const file of files) {
    if (!file.type.startsWith('image/')) {
      return NextResponse.json({ error: '仅支持图片' }, { status: 400 });
    }
    if (file.size > MAX_IMAGE_BYTES) {
      return NextResponse.json({ error: '单张图片不能超过 5MB' }, { status: 400 });
    }
    const buf = Buffer.from(await file.arrayBuffer());
    images.push(`data:${file.type};base64,${buf.toString('base64')}`);
  }

  const meta = {
    path: str(form.get('path')) || '/',
    ua: request.headers.get('user-agent') || '',
    referer: request.headers.get('referer') || '',
    ip: clientIp(request),
  };

  try {
    await prisma.feedback.create({
      data: {
        content,
        contact: contact || null,
        images,
        meta,
        status: 'new',
      },
    });
  } catch (e) {
    console.error('[api/feedback] save failed:', e);
    return NextResponse.json({ error: '提交失败，请稍后重试' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

export async function GET(request: NextRequest) {
  if (!rateLimit(`feedback:list:${clientIp(request)}`, 30, 60_000)) {
    return NextResponse.json({ error: '请求过于频繁' }, { status: 429 });
  }
  const sp = new URL(request.url).searchParams;
  const limit = Math.min(Math.max(parseInt(sp.get('limit') || '50', 10) || 50, 1), 100);
  const offset = Math.max(parseInt(sp.get('offset') || '0', 10) || 0, 0);

  try {
    const items = await prisma.$queryRaw<FeedbackListItem[]>`
      SELECT id, content, contact, meta->>'path' AS path,
             COALESCE(jsonb_array_length(images), 0)::int AS "imageCount",
             status, created_at AS "createdAt"
      FROM feedbacks
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    return NextResponse.json({ items });
  } catch (e) {
    console.error('[api/feedback GET]', e);
    return NextResponse.json({ error: '查询失败' }, { status: 500 });
  }
}
