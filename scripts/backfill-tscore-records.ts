/**
 * 波段评分(做T)信号收益回填
 *
 * 对 intradayReturn/nextDayReturn 为空的 TScoreRecord：
 *   - intradayReturn = 当日收盘 / 信号时刻价格 - 1（做T日内视角：信号后到收盘）
 *   - nextDayReturn  = 次日收盘 / 当日收盘 - 1（隔日视角）
 * 价格取 daily_bars（收盘口径）；tsCode 需 sina→Tushare 转换。
 * 当日数据未同步到 → 跳过，下次再跑（run-daily 16:00 同步后即回填当日）。
 *
 * 用法:
 *   npx tsx scripts/backfill-tscore-records.ts
 */

import { prisma } from '../lib/db';

/** sina 格式(sz002415) → Tushare 格式(002415.SZ) */
function toTushareCode(c: string): string {
  const m = c.match(/^([a-z]{2})(\d{6})$/i);
  return m ? `${m[2]}.${m[1].toUpperCase()}` : c;
}

async function main() {
  const pending = await prisma.tScoreRecord.findMany({
    where: { OR: [{ intradayReturn: null }, { nextDayReturn: null }] },
    select: { id: true, tsCode: true, tradeDate: true, price: true, intradayReturn: true, nextDayReturn: true },
    take: 50000,
  });
  console.log(`[backfill-tscore] 待回填 ${pending.length} 条`);
  if (pending.length === 0) { await prisma.$disconnect(); return; }

  // 交易日序列（升序）
  const dayRows = await prisma.dailyBar.findMany({
    select: { tradeDate: true },
    distinct: ['tradeDate'],
    orderBy: { tradeDate: 'asc' },
  });
  const days = dayRows.map((d) => d.tradeDate);
  const dayIndex = new Map(days.map((d, i) => [d, i]));

  // 按票×日批量取收盘价
  const codes = [...new Set(pending.map((p) => toTushareCode(p.tsCode)))];
  const dates = [...new Set(pending.map((p) => p.tradeDate))];
  const bars = await prisma.dailyBar.findMany({
    where: { tsCode: { in: codes }, tradeDate: { in: dates } },
    select: { tsCode: true, tradeDate: true, close: true },
  });
  const closeBy = new Map<string, Map<string, number>>();
  for (const b of bars) {
    let m = closeBy.get(b.tsCode);
    if (!m) { m = new Map(); closeBy.set(b.tsCode, m); }
    if (b.close != null) m.set(b.tradeDate, b.close);
  }

  let computed = 0, pendingCount = 0;
  for (const p of pending) {
    const code = toTushareCode(p.tsCode);
    const close = closeBy.get(code)?.get(p.tradeDate);
    if (close == null || close <= 0) { pendingCount++; continue; }
    const updates: { intradayReturn?: number; nextDayReturn?: number } = {};
    if (p.intradayReturn == null) {
      // 信号价缺失或无效 → 无法算日内，只补隔日
      if (p.price != null && p.price > 0) {
        updates.intradayReturn = Math.round(((close / p.price - 1) * 100) * 100) / 100;
      }
    }
    if (p.nextDayReturn == null) {
      const idx = dayIndex.get(p.tradeDate);
      const next = idx != null ? days[idx + 1] : null;
      const nextClose = next ? closeBy.get(code)?.get(next) : null;
      if (nextClose != null && nextClose > 0) {
        updates.nextDayReturn = Math.round(((nextClose / close - 1) * 100) * 100) / 100;
      }
    }
    if (Object.keys(updates).length === 0) { pendingCount++; continue; }
    await prisma.tScoreRecord.update({ where: { id: p.id }, data: updates });
    computed++;
    if (computed % 500 === 0) console.log(`[backfill-tscore] 进度 ${computed}/${pending.length}`);
  }

  console.log(`[backfill-tscore] 完成：回填 ${computed}，待数据 ${pendingCount}`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error('[backfill-tscore] 失败:', e); process.exit(1); });
