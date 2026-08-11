/**
 * 每日简报生成（盘前提示 morning / 盘后日报 daily）
 *
 * 数据源：daily_bars（涨跌/涨停）+ market_breadth（情绪）+ fuyao（龙虎榜/涨停原因）+ ai_screen_runs（筛选表现）
 * 输出：结构化 JSON 写入 daily_briefs 表，复盘弹窗 tab 读取。
 *
 * 用法：
 *   npx tsx scripts/generate-daily-brief.ts --type=morning   # 盘前 9:10（昨日回顾+今日关注）
 *   npx tsx scripts/generate-daily-brief.ts --type=daily     # 盘后 18:30（当日总结+筛选表现）
 *   npx tsx scripts/generate-daily-brief.ts --type=daily --date=20260810  # 指定日期（补跑）
 *
 * cron：
 *   10 9 * * 1-5  → morning
 *   30 18 * * 1-5 → daily
 */

import { prisma } from '../lib/db';
import { getDragonTigerList } from '../lib/fuyao';

/** 东八区 YYYYMMDD */
const shDate = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(/-/g, '');
const pct = (v: number | null | undefined, d = 1) => (v == null || Number.isNaN(v) ? '--' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`);

interface BriefPayload {
  briefDate: string;
  type: 'morning' | 'daily';
  generatedAt: string;
  // 市场概况
  market: {
    upCount: number;
    downCount: number;
    avgChange: number | null;
    limitUp: number;
    limitDown: number;
    newHigh20: number | null;
    northMoney: number | null; // 万
  };
  // 龙虎榜亮点
  dragonTiger: {
    orgNetBuy: { name: string; amount: number }[]; // 机构净买入 Top3
    hotMoneyNetBuy: { name: string; amount: number }[]; // 游资净买入 Top3
    hotRank: { name: string; rank: number }[]; // 人气 Top3
  } | null;
  // 昨日筛选表现（仅 daily 有）
  aiScreen: {
    strategy: string;
    picks: number;
    t1WinRate: number | null; // T+1 胜率（已回填样本）
    best: { name: string; t1: number } | null;
    worst: { name: string; t1: number } | null;
  }[] | null;
  // 今日关注（仅 morning 有）
  focus: {
    strongIndustries: string[]; // 昨日强势行业 Top3
    watchStocks: { name: string; reason: string }[]; // 需关注标的（昨日炸板/连板中断等）
  } | null;
  // 一句话总结
  summary: string;
}

async function main() {
  const typeArg = process.argv.find((a) => a.startsWith('--type='))?.split('=')[1] as 'morning' | 'daily';
  const dateArg = process.argv.find((a) => a.startsWith('--date='))?.split('=')[1];
  if (!typeArg || !['morning', 'daily'].includes(typeArg)) {
    console.error('用法: --type=morning|daily [--date=YYYYMMDD]');
    process.exit(1);
  }

  // 目标日期：默认今天（东八区）
  const targetDate = dateArg || shDate(new Date());
  // morning 用昨日数据，daily 用当日数据
  const dataDate = typeArg === 'morning'
    ? shDate(new Date(new Date(`${targetDate.slice(0, 4)}-${targetDate.slice(4, 6)}-${targetDate.slice(6, 8)}`).getTime() - 86400000))
    : targetDate;

  console.log(`[daily-brief] type=${typeArg} target=${targetDate} data=${dataDate}`);

  // ── 市场概况（dataDate 当日）────────────────────────────
  const bars = await prisma.dailyBar.findMany({
    where: { tradeDate: dataDate, changePct: { not: null } },
    select: { changePct: true },
  });
  let upCount = 0, downCount = 0, sumChg = 0;
  for (const b of bars) {
    const c = b.changePct!;
    if (c > 0) upCount++; else if (c < 0) downCount++;
    sumChg += c;
  }
  const avgChg = bars.length ? sumChg / bars.length : null;

  const breadth = await prisma.marketBreadth.findUnique({
    where: { tradeDate: dataDate },
    select: { limitUp: true, limitDown: true, newHigh20: true },
  });
  const north = await prisma.northboundFlow.findUnique({
    where: { tradeDate: dataDate },
    select: { northMoney: true },
  });

  const market = {
    upCount,
    downCount,
    avgChange: avgChg != null ? Math.round(avgChg * 100) / 100 : null,
    limitUp: breadth?.limitUp ?? 0,
    limitDown: breadth?.limitDown ?? 0,
    newHigh20: breadth?.newHigh20 ?? null,
    northMoney: north?.northMoney ?? null,
  };

  // ── 龙虎榜（fuyao，昨日数据）────────────────────────────
  let dragonTiger: BriefPayload['dragonTiger'] = null;
  try {
    const fuyaoDate = `${dataDate.slice(0, 4)}-${dataDate.slice(4, 6)}-${dataDate.slice(6, 8)}`;
    const [org, hot] = await Promise.all([
      getDragonTigerList('org', fuyaoDate),
      getDragonTigerList('hot_money', fuyaoDate),
    ]);
    // 机构净买入 Top3（按 org_net_value 降序）
    const orgTop = (org.stock_items ?? [])
      .filter((s) => s.org_net_value != null && s.org_net_value > 0)
      .sort((a, b) => (b.org_net_value ?? 0) - (a.org_net_value ?? 0))
      .slice(0, 3)
      .map((s) => ({ name: s.name, amount: (s.org_net_value ?? 0) / 100000000 })); // 元→亿
    // 游资净买入 Top3（按 hot_money_net_value 降序）
    const hotTop = (hot.stock_items ?? [])
      .filter((s) => s.hot_money_net_value != null && s.hot_money_net_value > 0)
      .sort((a, b) => (b.hot_money_net_value ?? 0) - (a.hot_money_net_value ?? 0))
      .slice(0, 3)
      .map((s) => ({ name: s.name, amount: (s.hot_money_net_value ?? 0) / 100000000 }));
    // 人气 Top3（hot_rank 越小越前）
    const rankTop = (org.stock_items ?? [])
      .filter((s) => s.hot_rank != null)
      .sort((a, b) => (a.hot_rank ?? 999) - (b.hot_rank ?? 999))
      .slice(0, 3)
      .map((s) => ({ name: s.name, rank: s.hot_rank! }));
    dragonTiger = { orgNetBuy: orgTop, hotMoneyNetBuy: hotTop, hotRank: rankTop };
  } catch (e: any) {
    console.warn(`[daily-brief] 龙虎榜拉取失败: ${e.message?.slice(0, 60)}`);
  }

  // ── 昨日筛选表现（仅 daily：当日入选的 T+1 已回填）────────────────────────────
  let aiScreen: BriefPayload['aiScreen'] = null;
  if (typeArg === 'daily') {
    const runs = await prisma.aiScreenRun.findMany({
      where: { barDate: dataDate },
      select: { id: true, strategyName: true },
    });
    const rows: BriefPayload['aiScreen'] = [];
    for (const run of runs) {
      const picks = await prisma.aiScreenPick.findMany({
        where: { runId: run.id, selected: true },
        include: { evals: { where: { nDays: 1 }, select: { returnPct: true } } },
      });
      const evaluated = picks.filter((p) => p.evals.length > 0 && p.evals[0].returnPct != null);
      const win = evaluated.filter((p) => p.evals[0].returnPct! > 0).length;
      const sorted = [...evaluated].sort((a, b) => (b.evals[0].returnPct ?? 0) - (a.evals[0].returnPct ?? 0));
      rows.push({
        strategy: run.strategyName,
        picks: picks.length,
        t1WinRate: evaluated.length ? Math.round((win / evaluated.length) * 1000) / 10 : null,
        best: sorted[0] ? { name: sorted[0].name, t1: sorted[0].evals[0].returnPct! } : null,
        worst: sorted[sorted.length - 1] ? { name: sorted[sorted.length - 1].name, t1: sorted[sorted.length - 1].evals[0].returnPct! } : null,
      });
    }
    aiScreen = rows.length ? rows : null;
  }

  // ── 今日关注（仅 morning：昨日强势行业 + 需关注标的）────────────────────────────
  let focus: BriefPayload['focus'] = null;
  if (typeArg === 'morning') {
    // 昨日强势行业（sw_index_daily 涨幅 Top3）
    const industries = await prisma.swIndexDaily.findMany({
      where: { tradeDate: dataDate, pctChg: { not: null } },
      select: { tsCode: true, pctChg: true },
      orderBy: { pctChg: 'desc' },
      take: 3,
    });
    const industryNames = await prisma.thsIndex.findMany({
      where: { thscode: { in: industries.map((i) => i.tsCode) } },
      select: { thscode: true, name: true },
    });
    const nameMap = new Map(industryNames.map((n) => [n.thscode, n.name]));
    const strongIndustries = industries.map((i) => nameMap.get(i.tsCode) ?? i.tsCode);

    // 需关注标的：昨日炸板（涨停后开板）+ 连板中断
    const watchStocks: { name: string; reason: string }[] = [];
    try {
      const limitUp = await prisma.dailyBar.findMany({
        where: { tradeDate: dataDate, changePct: { gte: 9.5 } },
        select: { tsCode: true, changePct: true },
        take: 10,
      });
      const stockNames = await prisma.stock.findMany({
        where: { tsCode: { in: limitUp.map((l) => l.tsCode) } },
        select: { tsCode: true, name: true },
      });
      const nameMap2 = new Map(stockNames.map((s) => [s.tsCode, s.name]));
      for (const l of limitUp.slice(0, 5)) {
        watchStocks.push({ name: nameMap2.get(l.tsCode) ?? l.tsCode, reason: `昨日涨停 ${pct(l.changePct)}` });
      }
    } catch { /* 静默 */ }

    focus = { strongIndustries, watchStocks };
  }

  // ── 一句话总结 ─────────────────────────────
  const marketTone = avgChg != null ? (avgChg > 0.5 ? '强势' : avgChg > 0 ? '偏强' : avgChg > -0.5 ? '偏弱' : '弱势') : '数据不足';
  const summary = typeArg === 'morning'
    ? `昨日市场${marketTone}，涨 ${upCount}/跌 ${downCount}，涨停 ${market.limitUp} 家。${dragonTiger?.orgNetBuy[0] ? `机构净买入 ${dragonTiger.orgNetBuy[0].name}。` : ''}今日关注：${focus?.strongIndustries.join('、') ?? '无'}。`
    : `今日市场${marketTone}，涨 ${upCount}/跌 ${downCount}，涨停 ${market.limitUp} 家。${aiScreen?.[0] ? `${aiScreen[0].strategy} T+1 胜率 ${aiScreen[0].t1WinRate}%。` : ''}`;

  const payload: BriefPayload = {
    briefDate: targetDate,
    type: typeArg,
    generatedAt: new Date().toISOString(),
    market,
    dragonTiger,
    aiScreen,
    focus,
    summary,
  };

  await prisma.dailyBrief.upsert({
    where: { briefDate_type: { briefDate: targetDate, type: typeArg } },
    create: { briefDate: targetDate, type: typeArg, payload: JSON.stringify(payload), createdAt: new Date().toISOString() },
    update: { payload: JSON.stringify(payload), createdAt: new Date().toISOString() },
  });

  console.log(`[daily-brief] 已生成 ${typeArg} ${targetDate}`);
  console.log(summary);
  await prisma.$disconnect();
}

main().catch((e) => { console.error('[daily-brief] 失败:', e); process.exit(1); });
