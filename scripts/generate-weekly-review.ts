/**
 * 周回顾生成（周日 cron 跑）— 产出混合结构周报（顶部小结 + 数据复盘）
 *
 * 内容：
 *   - 市场：本周涨跌家数 / 平均涨跌（daily_bars 全市场）
 *   - AI 筛选：运行次数 / 入选建议 / 本周已回填 T+1 最佳最差
 *   - 深度分析：次数 / 方向分布 / 本周高信心买入建议
 *   - 预警：本周触发明细 Top 规则与标的（alert_rule_triggers）
 * 写入 weekly_reviews（weekStart 唯一，重复跑覆盖）。
 *
 * 用法: npx tsx scripts/generate-weekly-review.ts
 * cron: 0 18 * * 5   （周五 18:00 生成，周六早就能看；周五入选建议的 T+1 下周一才回填，周报中缺席属正常）
 */

import { prisma } from '../lib/db';

/** 东八区 YYYYMMDD */
const shDate = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(/-/g, '');

const pct = (v: number | null | undefined, d = 1) => (v == null || Number.isNaN(v) ? '--' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`);
const signed = (v: number | null | undefined) => (v == null ? '--' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);

async function main() {
  // 本周一（东八区）
  const now = new Date();
  const todaySh = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const daysBack = (todaySh.getDay() + 6) % 7;
  const weekStart = new Date(todaySh.getTime() - daysBack * 86400000);
  const ws = shDate(weekStart);
  const we = shDate(new Date(weekStart.getTime() + 6 * 86400000));
  const weekLabel = `${ws.slice(0, 4)}-${ws.slice(4, 6)}-${ws.slice(6, 8)} ~ ${we.slice(4, 6)}-${we.slice(6, 8)}`;
  console.log(`[weekly] 周 ${ws} ~ ${we}`);

  // ── 市场：全市场涨跌家数 + 平均涨跌 ─────────────────────────────
  const marketRows = await prisma.dailyBar.findMany({
    where: { tradeDate: { gte: ws, lte: we }, changePct: { not: null } },
    select: { tradeDate: true, changePct: true },
  });
  let upCount = 0, downCount = 0, sumChg = 0;
  const perDay = new Map<string, { up: number; down: number }>();
  for (const r of marketRows) {
    const c = r.changePct!;
    if (c > 0) upCount++; else if (c < 0) downCount++;
    sumChg += c;
    let d = perDay.get(r.tradeDate);
    if (!d) { d = { up: 0, down: 0 }; perDay.set(r.tradeDate, d); }
    if (c > 0) d.up++; else if (c < 0) d.down++;
  }
  const avgChg = marketRows.length ? sumChg / marketRows.length : null;
  const market = {
    upCount, downCount,
    avgChange: avgChg != null ? Math.round(avgChg * 100) / 100 : null,
    days: [...perDay.entries()].map(([date, d]) => ({ date: date.slice(4, 6) + '-' + date.slice(6, 8), up: d.up, down: d.down })),
  };

  // ── AI 筛选：本周运行 + 入选建议 T+1 表现 ────────────────────────
  const wsISO = new Date(`${ws.slice(0, 4)}-${ws.slice(4, 6)}-${ws.slice(6, 8)}T00:00:00+08:00`).toISOString();
  const runs = await prisma.aiScreenRun.findMany({
    where: { createdAt: { gte: wsISO } },
    select: { id: true, strategyName: true },
  });
  const picks = await prisma.aiScreenPick.findMany({
    where: { runId: { in: runs.map((r) => r.id) }, selected: true },
    include: { evals: { select: { nDays: true, returnPct: true } } },
    take: 500,
  });
  const scored = picks
    .map((p) => ({ name: p.name, tsCode: p.tsCode, t1: p.evals.find((e) => e.nDays === 1)?.returnPct ?? null }))
    .filter((p) => p.t1 != null);
  const best = [...scored].sort((a, b) => (b.t1 ?? -999) - (a.t1 ?? -999)).slice(0, 3);
  const worst = [...scored].sort((a, b) => (a.t1 ?? 999) - (b.t1 ?? 999)).slice(0, 3);
  const aiScreen = {
    runs: runs.length,
    picks: picks.length,
    evaluatedT1: scored.length,
    best,
    worst,
  };

  // ── 深度分析：本周次数 / 方向分布 / 高信心买入 ───────────────────
  const deepRecords = await prisma.deepAnalysisRecord.findMany({
    where: { createdAt: { gte: wsISO } },
    select: { stockCode: true, stockName: true, action: true, confidence: true, targetHigh: true, stopLoss: true, reasoning: true },
    take: 500,
  });
  const byAction: Record<string, number> = {};
  for (const r of deepRecords) byAction[r.action] = (byAction[r.action] ?? 0) + 1;
  const deepTopPicks = deepRecords
    .filter((r) => r.action === '买入')
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
    .slice(0, 5)
    .map((r) => ({ name: r.stockName, confidence: r.confidence, target: r.targetHigh }));
  const deep = { count: deepRecords.length, byAction, topPicks: deepTopPicks };

  // ── 预警：本周触发 Top ─────────────────────────────────────────
  const triggers = await prisma.alertRuleTrigger.findMany({
    where: { barDate: { gte: ws, lte: we } },
    select: { subLabel: true, stockName: true, tsCode: true },
    take: 50000,
  });
  const ruleCount = new Map<string, number>();
  const stockCount = new Map<string, { name: string; n: number }>();
  for (const t of triggers) {
    ruleCount.set(t.subLabel, (ruleCount.get(t.subLabel) ?? 0) + 1);
    let s = stockCount.get(t.tsCode);
    if (!s) { s = { name: t.stockName ?? t.tsCode, n: 0 }; stockCount.set(t.tsCode, s); }
    s.n++;
  }
  const alerts = {
    total: triggers.length,
    topRules: [...ruleCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([label, n]) => ({ label, n })),
    topStocks: [...stockCount.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 5).map(([, s]) => s),
  };

  // ── 小结文案（混合结构：顶部阅读 + 底部数据）────────────────────
  const marketTone = avgChg != null ? (avgChg > 0 ? `偏强（周均 ${pct(avgChg)}，涨 ${upCount} / 跌 ${downCount}）` : avgChg < 0 ? `偏弱（周均 ${pct(avgChg)}，涨 ${upCount} / 跌 ${downCount}）` : '震荡') : '数据不足';
  const summaryLines = [
    `本周（${weekLabel}）市场${marketTone}。`,
    `AI 筛选运行 ${runs.length} 次，入选 ${picks.length} 条建议${scored.length > 0 && best[0] ? `，本周 T+1 最佳 ${best[0].name} ${signed(best[0].t1)}` : ''}。`,
    `深度分析 ${deepRecords.length} 次${deep.byAction['买入'] ? `，买入建议 ${deep.byAction['买入']} 条` : ''}${deep.topPicks[0] ? `，最高信心 ${deep.topPicks[0].name}（${deep.topPicks[0].confidence}）` : ''}。`,
    `预警共触发 ${triggers.length} 次${alerts.topRules[0] ? `，最活跃信号「${alerts.topRules[0].label}」${alerts.topRules[0].n} 次` : ''}。`,
  ];

  const payload = {
    weekStart: ws,
    weekLabel,
    generatedAt: new Date().toISOString(),
    summary: summaryLines.join('\n'),
    market,
    aiScreen,
    deep,
    alerts,
  };

  const review = await prisma.weeklyReview.upsert({
    where: { weekStart: ws },
    create: { weekStart: ws, payload: JSON.stringify(payload), createdAt: new Date().toISOString() },
    update: { payload: JSON.stringify(payload), createdAt: new Date().toISOString() },
  });
  console.log(`[weekly] 已生成周报 ${review.weekStart}`);
  console.log(payload.summary);
  await prisma.$disconnect();
}

main().catch((e) => { console.error('[weekly] 失败:', e); process.exit(1); });
