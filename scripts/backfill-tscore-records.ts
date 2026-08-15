/**
 * 波段评分(做T)信号收益回填
 *
 * 对 intradayReturn/nextDayReturn 为空的 TScoreRecord：
 *   - intradayReturn = 当日收盘 / 信号时刻价格 - 1（做T日内视角：信号后到收盘）
 *   - nextDayReturn  = 次日收盘 / 当日收盘 - 1（隔日视角）
 * 价格取 daily_bars（收盘口径）；tsCode 需 sina→Tushare 转换。
 * 当日数据未同步到 → 跳过，下次再跑（run-daily 16:00 同步后即回填当日）。
 *
 * 性能口径（2026-08-15）：按 PK (tsCode, tradeDate) 精确取需要的 (股票,日期) 对
 * （当日 + 次日），取代旧的全票×全日超量加载；更新改批量（500/批单事务）。
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
  const dayRows = await prisma.$queryRawUnsafe<{ tradeDate: string }[]>(
    `SELECT DISTINCT "tradeDate" FROM daily_bars ORDER BY "tradeDate" ASC`
  );
  const days = dayRows.map((d) => d.tradeDate);
  const dayIndex = new Map(days.map((d, i) => [d, i]));

  // 收集需要的 (tsCode, tradeDate) 对：当日 + 次日
  const pairSet = new Set<string>();
  for (const p of pending) {
    const tc = toTushareCode(p.tsCode);
    pairSet.add(`${tc}|${p.tradeDate}`);
    const idx = dayIndex.get(p.tradeDate);
    const next = idx != null ? days[idx + 1] : null;
    if (next) pairSet.add(`${tc}|${next}`);
  }
  const pairs = [...pairSet].map((s) => s.split('|') as [string, string]);

  // 分块按 PK 精确取收盘价
  const closeBy = new Map<string, Map<string, number>>();
  for (let i = 0; i < pairs.length; i += 5000) {
    const chunk = pairs.slice(i, i + 5000);
    const placeholders = chunk.map((_, j) => `($${j * 2 + 1}, $${j * 2 + 2})`).join(',');
    const rows = await prisma.$queryRawUnsafe<{ tsCode: string; tradeDate: string; close: number | null }[]>(
      `SELECT "tsCode", "tradeDate", close FROM daily_bars WHERE ("tsCode", "tradeDate") IN (${placeholders})`,
      ...chunk.flat()
    );
    for (const r of rows) {
      if (r.close == null) continue;
      let m = closeBy.get(r.tsCode);
      if (!m) { m = new Map(); closeBy.set(r.tsCode, m); }
      m.set(r.tradeDate, r.close);
    }
  }

  let computed = 0, pendingCount = 0;
  const toApply: { id: string; data: { intradayReturn?: number; nextDayReturn?: number } }[] = [];
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
    toApply.push({ id: p.id, data: updates });
    computed++;
    if (computed % 500 === 0) console.log(`[backfill-tscore] 进度 ${computed}/${pending.length}`);
  }

  // 批量更新（500 一批单事务）
  for (let i = 0; i < toApply.length; i += 500) {
    const chunk = toApply.slice(i, i + 500);
    await prisma.$transaction(
      chunk.map((u) => prisma.tScoreRecord.update({ where: { id: u.id }, data: u.data }))
    );
  }

  console.log(`[backfill-tscore] 完成：回填 ${computed}，待数据 ${pendingCount}`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error('[backfill-tscore] 失败:', e); process.exit(1); });
