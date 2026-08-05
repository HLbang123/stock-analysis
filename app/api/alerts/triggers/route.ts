import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

/**
 * 预警触发明细落库
 * POST: 检查预警后批量写（R01 阶梯展开各子信号一行），静默失败不阻断前端。
 *   body: { triggers: [{ tsCode, stockName, ruleId, subLabel, barDate }] }
 */

interface TriggerInput {
  tsCode: string;
  stockName?: string;
  ruleId: string;
  subLabel: string;
  barDate: string;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const triggers: TriggerInput[] = Array.isArray(body?.triggers) ? body.triggers : [];
    if (triggers.length === 0) {
      return NextResponse.json({ ok: true, written: 0 });
    }
    if (triggers.length > 500) {
      return NextResponse.json({ error: '单次最多 500 条' }, { status: 400 });
    }

    const now = new Date().toISOString();
    let written = 0;
    for (const t of triggers) {
      if (!t.tsCode || !t.ruleId || !t.subLabel || !t.barDate) continue;
      try {
        await prisma.alertRuleTrigger.upsert({
          where: {
            tsCode_ruleId_subLabel_barDate_source: {
              tsCode: t.tsCode, ruleId: t.ruleId, subLabel: t.subLabel, barDate: t.barDate, source: 'online',
            },
          },
          create: {
            tsCode: t.tsCode,
            stockName: t.stockName ?? null,
            ruleId: t.ruleId,
            subLabel: t.subLabel,
            barDate: t.barDate,
            createdAt: now,
            source: 'online',
          },
          update: {}, // 已存在不更新（同日重查同信号只记一次）
        });
        written++;
      } catch (e: any) {
        console.warn('[api/alerts/triggers] upsert 失败:', t.tsCode, t.subLabel, e?.message);
      }
    }
    return NextResponse.json({ ok: true, written });
  } catch (e: any) {
    console.error('[api/alerts/triggers POST]', e);
    return NextResponse.json({ error: e.message || '落库失败' }, { status: 500 });
  }
}
