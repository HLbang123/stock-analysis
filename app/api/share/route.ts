import { NextRequest, NextResponse } from 'next/server';
import { randomInt } from 'node:crypto';
import { prisma } from '@/lib/db';
import { clientIp, rateLimit } from '@/lib/rate-limit';

/**
 * 自选分享 API（明文快照，读取免鉴权）
 * GET    ?code=123456  → {displayName, snapshot, updatedAt}   过期 404
 * POST   {code?, ownerToken, displayName, snapshot, expiresAt?} 创建（无 code 生成新码）/更新（校验 ownerToken）
 * DELETE {code, ownerToken}                                    撤销（幂等）
 *
 * 安全模型：6 位码是「读凭证」（内容公开，拿到就能看）；ownerToken 是「写凭证」
 * （分享方本地随机串，更新/撤销用，防他人篡改）。读取限流防遍历码空间。
 */

const SNAPSHOT_MAX = 200_000; // 快照 JSON 上限（组+标的，正常远小于此）

const genCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code') || '';
  if (!/^\d{6}$/.test(code)) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }
  if (!rateLimit(`share:get:${clientIp(request)}`, 30, 60_000)) {
    return NextResponse.json({ error: '请求过于频繁' }, { status: 429 });
  }
  try {
    const row = await prisma.shareSnapshot.findUnique({
      where: { code },
      select: { displayName: true, snapshot: true, updatedAt: true, expiresAt: true, ownerToken: true },
    });
    if (!row) return NextResponse.json({ error: '分享码不存在' }, { status: 404 });
    if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
      return NextResponse.json({ error: '分享已过期' }, { status: 404 });
    }

    // 分享方查询（带 ownerToken）：返回订阅人数，不给快照以外的东西
    const ownerToken = request.nextUrl.searchParams.get('ownerToken') || '';
    if (ownerToken && ownerToken === row.ownerToken) {
      const subscriberCount = await prisma.shareSubscriber.count({ where: { code } });
      return NextResponse.json({
        displayName: row.displayName,
        updatedAt: row.updatedAt.getTime(),
        subscriberCount,
      });
    }

    // 订阅方查询：可选 sid 登记订阅（设备 ID 去重，只统计人数）。
    // 登记失败不阻断读取（统计是附属功能）。
    const sid = request.nextUrl.searchParams.get('sid') || '';
    if (/^[a-f0-9]{8,32}$/.test(sid)) {
      const now = new Date();
      await prisma.shareSubscriber.upsert({
        where: { code_subscriberId: { code, subscriberId: sid } },
        create: { code, subscriberId: sid },
        update: { lastSeenAt: now },
      }).catch((e) => console.warn('[api/share] 订阅登记失败:', e?.message));
    }
    return NextResponse.json({
      displayName: row.displayName,
      snapshot: row.snapshot,
      updatedAt: row.updatedAt.getTime(),
    });
  } catch (e: any) {
    console.error('[api/share GET]', e);
    return NextResponse.json({ error: e.message || '查询失败' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!rateLimit(`share:post:${clientIp(request)}`, 10, 60_000)) {
    return NextResponse.json({ error: '请求过于频繁' }, { status: 429 });
  }
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }
  const { code, ownerToken, displayName, snapshot, expiresAt } = body ?? {};
  if (typeof ownerToken !== 'string' || ownerToken.length < 16 || ownerToken.length > 64) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }
  if (typeof displayName !== 'string' || !displayName.trim() || displayName.trim().length > 20) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }
  if (typeof snapshot !== 'string' || snapshot.length > SNAPSHOT_MAX) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }
  // expiresAt：null/缺省 = 长期；数字 = unix 毫秒
  let exp: Date | null = null;
  if (expiresAt != null) {
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
      return NextResponse.json({ error: '参数错误' }, { status: 400 });
    }
    exp = new Date(expiresAt);
  }
  const name = displayName.trim();
  try {
    if (typeof code === 'string' && /^\d{6}$/.test(code)) {
      // 更新：校验 ownerToken
      const existing = await prisma.shareSnapshot.findUnique({
        where: { code },
        select: { ownerToken: true },
      });
      if (!existing) return NextResponse.json({ error: '分享码不存在' }, { status: 404 });
      if (existing.ownerToken !== ownerToken) {
        return NextResponse.json({ error: '鉴权失败' }, { status: 401 });
      }
      await prisma.shareSnapshot.update({
        where: { code },
        data: { displayName: name, snapshot, expiresAt: exp },
      });
      return NextResponse.json({ ok: true, code });
    }
    // 创建：生成新码，撞码重试
    for (let i = 0; i < 5; i++) {
      const newCode = genCode();
      try {
        await prisma.shareSnapshot.create({
          data: { code: newCode, ownerToken, displayName: name, snapshot, expiresAt: exp },
        });
        return NextResponse.json({ ok: true, code: newCode });
      } catch (e: any) {
        if (e.code === 'P2002') continue; // 唯一键撞码
        throw e;
      }
    }
    return NextResponse.json({ error: '生成失败，请重试' }, { status: 500 });
  } catch (e: any) {
    console.error('[api/share POST]', e);
    return NextResponse.json({ error: e.message || '保存失败' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  if (!rateLimit(`share:del:${clientIp(request)}`, 10, 60_000)) {
    return NextResponse.json({ error: '请求过于频繁' }, { status: 429 });
  }
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }
  const { code, ownerToken, sid } = body ?? {};
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  // 订阅方退订：删自己的订阅登记（sid 即凭证——随机不可猜，且最坏影响只是计数减一）
  if (typeof sid === 'string' && /^[a-f0-9]{8,32}$/.test(sid)) {
    try {
      await prisma.shareSubscriber.deleteMany({ where: { code, subscriberId: sid } });
      return NextResponse.json({ ok: true });
    } catch (e: any) {
      console.error('[api/share DELETE sid]', e);
      return NextResponse.json({ error: e.message || '删除失败' }, { status: 500 });
    }
  }

  if (typeof ownerToken !== 'string') {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }
  try {
    const existing = await prisma.shareSnapshot.findUnique({
      where: { code },
      select: { ownerToken: true },
    });
    if (!existing) return NextResponse.json({ ok: true }); // 幂等删除
    if (existing.ownerToken !== ownerToken) {
      return NextResponse.json({ error: '鉴权失败' }, { status: 401 });
    }
    await prisma.shareSnapshot.delete({ where: { code } });
    await prisma.shareSubscriber.deleteMany({ where: { code } }).catch(() => {});
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error('[api/share DELETE]', e);
    return NextResponse.json({ error: e.message || '删除失败' }, { status: 500 });
  }
}
