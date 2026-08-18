import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

/**
 * GET /api/fund/premium?code=sh513100&price=1.234 — ETF 折溢价率
 *
 * 折溢价 = 现价 ÷ 最新单位净值 − 1。净值走 fuyao（有限流，按 code 缓存到次日凌晨），
 * 只对 cross-border/commodity 类返回（equity ETF 折溢价恒≈0，无监控意义；
 * fund_profiles 无记录时同样返回 null，前端不展示）。
 * price 由前端实时行情传入（服务端不另拉行情）；缺 price 时回落到 fund_daily_bars 最新收盘。
 */

interface NavCacheEntry { unitNav: number; navDate: string; expires: number }
const navCache = new Map<string, NavCacheEntry>();

/** sina 格式(sh513100) → Tushare 格式(513100.SH) */
function toTushareCode(c: string): string {
  const m = c.match(/^([a-z]{2})(\d{6})$/i);
  return m ? `${m[2]}.${m[1].toUpperCase()}` : c;
}

/** 净值缓存到次日 06:00（净值每晚更新一次；QDII 更晚，多缓存几小时无碍） */
function cacheExpiry(): number {
  const d = new Date(Date.now() + 8 * 3600_000); // 北京时
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(6, 0, 0, 0);
  return d.getTime() - 8 * 3600_000;
}

export async function GET(request: NextRequest) {
  try {
    const sp = new URL(request.url).searchParams;
    const rawCode = sp.get('code');
    if (!rawCode) return NextResponse.json({ error: '缺少 code' }, { status: 400 });
    const tsCode = toTushareCode(rawCode);

    // 品种门槛：只监控跨境/商品（QDII 溢价杀人是真实高频的坑）
    const profile = await prisma.fundProfile.findUnique({
      where: { tsCode },
      select: { assetClass: true },
    }).catch(() => null);
    if (!profile || (profile.assetClass !== 'cross-border' && profile.assetClass !== 'commodity')) {
      return NextResponse.json({ premiumPct: null });
    }

    // 净值（缓存）
    let entry = navCache.get(tsCode);
    if (!entry || entry.expires < Date.now()) {
      const { getFundNav } = await import('@/lib/fuyao');
      const nav = await getFundNav(tsCode);
      if (!nav || !nav.unit_nav) return NextResponse.json({ premiumPct: null });
      const d = new Date(nav.nav_date + 8 * 3600_000);
      entry = {
        unitNav: nav.unit_nav,
        navDate: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`,
        expires: cacheExpiry(),
      };
      navCache.set(tsCode, entry);
    }

    // 现价：前端实时价优先，缺省回落最近收盘
    let price = parseFloat(sp.get('price') ?? '');
    if (!Number.isFinite(price) || price <= 0) {
      const last = await prisma.fundDaily.findFirst({
        where: { tsCode },
        orderBy: { tradeDate: 'desc' },
        select: { close: true },
      });
      price = last?.close ?? 0;
    }
    if (price <= 0) return NextResponse.json({ premiumPct: null });

    const premiumPct = (price / entry.unitNav - 1) * 100;
    return NextResponse.json({
      premiumPct: Math.round(premiumPct * 100) / 100,
      navDate: entry.navDate,
      unitNav: entry.unitNav,
    });
  } catch (e: any) {
    console.error('[api/fund/premium]', e);
    return NextResponse.json({ error: e.message || '查询失败' }, { status: 500 });
  }
}
