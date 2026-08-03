/**
 * 筹码分布查询
 * GET /api/chip?code=000001  → ChipDistribution JSON
 *
 * 数据来自 daily_bars（含 turnover_rate），走 lib/chip.ts 换手率转移模型。
 * 用于预警 R14/R15、AI 深度分析、对话工具。
 */
import { NextRequest, NextResponse } from 'next/server';
import { getChipDistribution } from '@/lib/chip';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const days = searchParams.get('days');

  if (!code) {
    return NextResponse.json({ error: '缺少股票代码' }, { status: 400 });
  }

  try {
    const chip = await getChipDistribution(code, days ? Number(days) : 90);
    if (!chip) {
      return NextResponse.json({ error: '筹码数据不足（需≥5根含换手率的日线）' }, { status: 404 });
    }
    return NextResponse.json(chip);
  } catch (e: any) {
    return NextResponse.json({ error: e.message?.slice(0, 120) }, { status: 500 });
  }
}
