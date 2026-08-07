import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { clientIp, rateLimit } from '@/lib/rate-limit';

/**
 * 云同步快照 API（零知识：服务器只存密文 blob）
 * GET  ?syncId=&versionOnly=1 → {version}          轮询轻接口
 * GET  ?syncId=              → {version, blob}     拉取（密文，无鉴权无害）
 * POST {syncId, keyHash, baseVersion, blob}        上传；keyHash 不符 401；baseVersion 过期 409 {version}
 * DELETE {syncId, keyHash}                         关闭同步/换码时删快照（含其配对行）
 */

const BLOB_MAX = 1_500_000; // 密文 JSON 上限（与前端引擎一致）

export async function GET(request: NextRequest) {
  const syncId = request.nextUrl.searchParams.get('syncId') || '';
  if (!syncId || syncId.length > 36) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }
  const versionOnly = request.nextUrl.searchParams.get('versionOnly') === '1';
  // 轮询是合法高频（L2 档每设备 60s 一次），限流放宽；拉取/上传收紧
  if (!rateLimit(`sync:get:${clientIp(request)}`, versionOnly ? 60 : 10, 60_000)) {
    return NextResponse.json({ error: '请求过于频繁' }, { status: 429 });
  }
  try {
    const row = await prisma.syncSnapshot.findUnique({
      where: { syncId },
      select: { version: true, blob: true },
    });
    if (!row) return NextResponse.json({ error: '未找到' }, { status: 404 });
    return NextResponse.json(
      versionOnly ? { version: row.version } : { version: row.version, blob: row.blob }
    );
  } catch (e: any) {
    console.error('[api/sync GET]', e);
    return NextResponse.json({ error: e.message || '查询失败' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!rateLimit(`sync:post:${clientIp(request)}`, 10, 60_000)) {
    return NextResponse.json({ error: '请求过于频繁' }, { status: 429 });
  }
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }
  const { syncId, keyHash, baseVersion, blob } = body ?? {};
  if (typeof syncId !== 'string' || typeof keyHash !== 'string' || typeof blob !== 'string') {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }
  if (syncId.length > 36 || keyHash.length > 64 || blob.length > BLOB_MAX) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }
  const baseV = typeof baseVersion === 'number' ? baseVersion : 0;
  try {
    const existing = await prisma.syncSnapshot.findUnique({
      where: { syncId },
      select: { version: true, keyHash: true },
    });
    if (existing) {
      if (existing.keyHash !== keyHash) {
        return NextResponse.json({ error: '鉴权失败' }, { status: 401 });
      }
      if (existing.version !== baseV) {
        return NextResponse.json({ version: existing.version }, { status: 409 });
      }
      const updated = await prisma.syncSnapshot.update({
        where: { syncId },
        data: { blob, version: { increment: 1 } },
        select: { version: true },
      });
      return NextResponse.json({ ok: true, version: updated.version });
    }
    const created = await prisma.syncSnapshot.create({
      data: { syncId, keyHash, blob, version: 1 },
      select: { version: true },
    });
    return NextResponse.json({ ok: true, version: created.version });
  } catch (e: any) {
    console.error('[api/sync POST]', e);
    return NextResponse.json({ error: e.message || '保存失败' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  if (!rateLimit(`sync:del:${clientIp(request)}`, 10, 60_000)) {
    return NextResponse.json({ error: '请求过于频繁' }, { status: 429 });
  }
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }
  const { syncId, keyHash } = body ?? {};
  if (typeof syncId !== 'string' || typeof keyHash !== 'string') {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }
  try {
    const existing = await prisma.syncSnapshot.findUnique({
      where: { syncId },
      select: { keyHash: true },
    });
    if (existing && existing.keyHash !== keyHash) {
      return NextResponse.json({ error: '鉴权失败' }, { status: 401 });
    }
    // 快照 + 该身份所有配对行一并删
    await prisma.$transaction([
      prisma.syncPairing.deleteMany({ where: { syncId } }),
      prisma.syncSnapshot.deleteMany({ where: { syncId } }),
    ]);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error('[api/sync DELETE]', e);
    return NextResponse.json({ error: e.message || '删除失败' }, { status: 500 });
  }
}
