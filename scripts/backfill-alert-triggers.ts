/**
 * 预警触发明细 T+N 回填
 *
 * 对 t5Return/t10Return 为空的触发行，按 barDate 在 daily_bars 里取
 * 第 N 个交易日收盘价算收益（T+N 绝对收益%）。
 * 目标日数据未到 → 跳过，下次再跑。upsert 幂等。
 *
 * 用法:
 *   npx tsx scripts/backfill-alert-triggers.ts            # 全部待回填
 *   npx tsx scripts/backfill-alert-triggers.ts --limit=1000
 */

import { prisma } from '../lib/db';

/** sina 格式(sz002415/sh600664) → Tushare 格式(002415.SZ/600664.SH)。
 *  trigger.tsCode 来自前端(sina 口径)，daily_bars.tsCode 是 Tushare 口径——不转换永远查不到 */
function toTushareCode(c: string): string {
  const m = c.match(/^([a-z]{2})(\d{6})$/i);
  return m ? `${m[2]}.${m[1].toUpperCase()}` : c;
}

async function main() {
  const limit = parseInt(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] || '100000');

  // 交易日序列（升序）
  const dayRows = await prisma.dailyBar.findMany({
    select: { tradeDate: true },
    distinct: ['tradeDate'],
    orderBy: { tradeDate: 'asc' },
  });
  const days = dayRows.map((d) => d.tradeDate);
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  console.log(`[backfill-alert-triggers] 交易日 ${days.length} 天（${days[0]}~${days[days.length - 1]}）`);

  const pending = await prisma.alertRuleTrigger.findMany({
    where: { OR: [{ t5Return: null }, { t10Return: null }] },
    select: { id: true, tsCode: true, barDate: true, t5Return: true, t10Return: true },
    take: limit,
  });
  console.log(`[backfill-alert-triggers] 待回填 ${pending.length} 条`);

  // 按 barDate 批量取收盘价（一次查回所有需要的日×票）
  const dates = [...new Set(pending.map((p) => p.barDate))];
  const bars = await prisma.dailyBar.findMany({
    where: { tradeDate: { in: dates } },
    select: { tsCode: true, tradeDate: true, close: true },
  });
  const closeBy = new Map<string, Map<string, number>>();
  for (const b of bars) {
    let m = closeBy.get(b.tradeDate);
    if (!m) { m = new Map(); closeBy.set(b.tradeDate, m); }
    if (b.close != null) m.set(b.tsCode, b.close);
  }

  let computed = 0, pendingCount = 0;
  for (const p of pending) {
    const idx = dayIndex.get(p.barDate);
    if (idx == null) { pendingCount++; continue; }
    const tushareCode = toTushareCode(p.tsCode);
    const entry = closeBy.get(p.barDate)?.get(tushareCode);
    if (entry == null || entry <= 0) { pendingCount++; continue; }
    const updates: { t5Return?: number; t10Return?: number } = {};
    if (p.t5Return == null) {
      const d5 = days[idx + 5];
      const c5 = d5 ? closeBy.get(d5)?.get(tushareCode) : null;
      if (c5 != null && c5 > 0) updates.t5Return = Math.round(((c5 / entry - 1) * 100) * 100) / 100;
    }
    if (p.t10Return == null) {
      const d10 = days[idx + 10];
      const c10 = d10 ? closeBy.get(d10)?.get(tushareCode) : null;
      if (c10 != null && c10 > 0) updates.t10Return = Math.round(((c10 / entry - 1) * 100) * 100) / 100;
    }
    if (Object.keys(updates).length === 0) { pendingCount++; continue; }
    await prisma.alertRuleTrigger.update({ where: { id: p.id }, data: updates });
    computed++;
    if (computed % 500 === 0) console.log(`[backfill-alert-triggers] 进度 ${computed}/${pending.length}`);
  }

  console.log(`[backfill-alert-triggers] 完成：回填 ${computed}，待数据 ${pendingCount}`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error('[backfill-alert-triggers] 失败:', e); process.exit(1); });
