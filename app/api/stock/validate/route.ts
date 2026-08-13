import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { validateStockCode } from '@/lib/identify';

/**
 * POST /api/stock/validate — 批量校验 6 位代码并查名（OCR 识图等场景）
 * body: { codes: string[] }（≤50 个）
 * 返回 { items: [{ code: 'sh600519', name: '贵州茅台' }] }
 * 只查本地 stocks 名录，不依赖实时行情源（外部源限流/抖动曾致 OCR 整批误判无效）
 */
export async function POST(request: NextRequest) {
  try {
    const { codes } = await request.json();
    if (!Array.isArray(codes) || codes.length === 0) {
      return NextResponse.json({ error: '缺少 codes' }, { status: 400 });
    }
    const valids = codes
      .slice(0, 50)
      .map((c) => validateStockCode(String(c)))
      .filter((v): v is NonNullable<typeof v> => v !== null);
    if (valids.length === 0) return NextResponse.json({ items: [] });

    const tsCodes = [...new Set(valids.map((v) => `${v.pureCode}.${v.market.toUpperCase()}`))];
    const placeholders = tsCodes.map((_, i) => `$${i + 1}`).join(',');
    const rows: { ts_code: string; name: string }[] = await prisma.$queryRawUnsafe(
      `SELECT ts_code, name FROM stocks WHERE ts_code IN (${placeholders}) AND is_active = true`,
      ...tsCodes
    );
    const nameByTs = new Map(rows.map((r) => [r.ts_code, r.name]));

    const seen = new Set<string>();
    const items: { code: string; name: string }[] = [];
    for (const v of valids) {
      const name = nameByTs.get(`${v.pureCode}.${v.market.toUpperCase()}`);
      const code = `${v.market}${v.pureCode}`;
      if (name && !seen.has(code)) {
        seen.add(code);
        items.push({ code, name });
      }
    }
    return NextResponse.json({ items });
  } catch (e: any) {
    return NextResponse.json({ error: e.message?.slice(0, 120) }, { status: 500 });
  }
}
