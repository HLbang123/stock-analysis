import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { clientIp, rateLimit } from '@/lib/rate-limit';

/**
 * 配对码 API（微信输入法式：短码只做"配对瞬间"的凭证，不做长期密钥）
 * POST {codeHash, syncId, wrappedKey}  已同步设备生成配对行（10 分钟 TTL；同 syncId 旧行先删）
 * GET  ?codeHash=                     新设备取回 {syncId, wrappedKey} 并立即删行（一次性）
 *
 * 安全模型：6 位码 1M 空间 + 10 分钟窗口 + IP 限流（10/min），爆破成功率约 0.01%/窗口，
 * 且攻击者无从知道"此刻谁在配对"。wrapped_key 本身也是配对码派生密钥加密的密文。
 */

const WRAPPED_KEY_MAX = 5000;

export async function POST(request: NextRequest) {
  if (!rateLimit(`pair:post:${clientIp(request)}`, 5, 60_000)) {
    return NextResponse.json({ error: '生成过于频繁' }, { status: 429 });
  }
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }
  const { codeHash, syncId, wrappedKey } = body ?? {};
  if (typeof codeHash !== 'string' || typeof syncId !== 'string' || typeof wrappedKey !== 'string') {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }
  if (codeHash.length !== 64 || syncId.length > 36 || wrappedKey.length > WRAPPED_KEY_MAX) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }
  try {
    // 一台设备同时只挂一个配对：旧码作废；顺手清掉该身份已过期的行
    await prisma.$transaction([
      prisma.syncPairing.deleteMany({ where: { syncId } }),
      prisma.syncPairing.deleteMany({ where: { codeHash } }),
    ]);
    await prisma.syncPairing.create({
      data: { codeHash, syncId, wrappedKey, expiresAt: new Date(Date.now() + 10 * 60 * 1000) },
    });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error('[api/sync/pair POST]', e);
    return NextResponse.json({ error: e.message || '生成失败' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  if (!rateLimit(`pair:get:${clientIp(request)}`, 10, 60_000)) {
    return NextResponse.json({ error: '尝试过于频繁' }, { status: 429 });
  }
  const codeHash = request.nextUrl.searchParams.get('codeHash') || '';
  if (codeHash.length !== 64) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }
  try {
    const row = await prisma.syncPairing.findUnique({
      where: { codeHash },
      select: { syncId: true, wrappedKey: true, expiresAt: true },
    });
    if (!row || row.expiresAt.getTime() < Date.now()) {
      // 过期残留顺手清（惰性 TTL）
      if (row) await prisma.syncPairing.delete({ where: { codeHash } });
      return NextResponse.json({ error: '配对码无效或已过期' }, { status: 404 });
    }
    // 一次性：取走即焚
    await prisma.syncPairing.delete({ where: { codeHash } });
    return NextResponse.json({ syncId: row.syncId, wrappedKey: row.wrappedKey });
  } catch (e: any) {
    console.error('[api/sync/pair GET]', e);
    return NextResponse.json({ error: e.message || '查询失败' }, { status: 500 });
  }
}
