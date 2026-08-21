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

/**
 * 归一化 barDate 为 8 位 YYYYMMDD。
 * 兼容陈旧客户端发来的 "2026/8/21"、"2026-8-21"、"2026／8／21"（全角斜杠）等格式，
 * 避免 9+ 字符溢出 bar_date VARCHAR(8) 导致静默丢数据（2026-08-21 服务器日志定位）。
 * 非法/无法解析的输入返回 null，由调用方跳过。
 */
function normalizeBarDate(input: string): string | null {
  const s = String(input).trim();
  if (/^\d{8}$/.test(s)) return s;
  const m = s.match(/^(\d{4})\D+(\d{1,2})\D+(\d{1,2})$/);
  if (!m) return null;
  const mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return m[1] + m[2].padStart(2, '0') + m[3].padStart(2, '0');
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
      const barDate = normalizeBarDate(t.barDate);
      if (!barDate) {
        console.warn('[api/alerts/triggers] barDate 非法，跳过:', t.tsCode, t.ruleId, t.subLabel, t.barDate);
        continue;
      }
      try {
        await prisma.alertRuleTrigger.upsert({
          where: {
            tsCode_ruleId_subLabel_barDate_source: {
              tsCode: t.tsCode, ruleId: t.ruleId, subLabel: t.subLabel, barDate, source: 'online',
            },
          },
          create: {
            tsCode: t.tsCode,
            stockName: t.stockName ?? null,
            ruleId: t.ruleId,
            subLabel: t.subLabel,
            barDate,
            createdAt: now,
            source: 'online',
          },
          update: {}, // 已存在不更新（同日重查同信号只记一次）
        });
        written++;
      } catch (e: any) {
        console.warn('[api/alerts/triggers] upsert 失败:', JSON.stringify({ tsCode: t.tsCode, stockName: t.stockName, ruleId: t.ruleId, subLabel: t.subLabel, barDate }), e?.message);
      }
    }
    return NextResponse.json({ ok: true, written });
  } catch (e: any) {
    console.error('[api/alerts/triggers POST]', e);
    return NextResponse.json({ error: e.message || '落库失败' }, { status: 500 });
  }
}
