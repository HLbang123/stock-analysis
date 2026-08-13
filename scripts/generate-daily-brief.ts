/**
 * 每日简报生成（盘前提示 morning / 盘后日报 daily）
 *
 * 数据源：daily_bars（涨跌）+ market_breadth（情绪）+ industry_moneyflow_ths（板块资金）
 *         + fuyao 龙虎榜 + tushare limit_list_d（炸板/连板中断）+ ai_screen_runs（筛选表现）
 *         + alert_rule_triggers（预警触发概况，仅 daily）
 * 解读：服务器 LLM（AI_SCREEN_API_KEY 等环境变量，复用 AI 筛选配置；缺失/失败回退模板文案，不阻断生成）
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
import { getLimitListD } from '../lib/tushare';
import { getServerScreenCfg } from '../services/ai-screen/server-cfg';
import { buildChatUrl, buildLLMHeaders, createTimeoutSignal } from '../lib/llm/shared';

/** 东八区 YYYYMMDD */
const shDate = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(/-/g, '');
const pct = (v: number | null | undefined, d = 1) => (v == null || Number.isNaN(v) ? '--' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`);
/** 近端交易日：morning 取 target 之前，daily 取 ≤ target（周一盘前用日历减一天会拿到周日空数据） */
async function latestTradeDate(targetDate: string, type: 'morning' | 'daily'): Promise<string | null> {
  const row = await prisma.dailyBar.findFirst({
    where: { tradeDate: type === 'morning' ? { lt: targetDate } : { lte: targetDate } },
    orderBy: { tradeDate: 'desc' },
    select: { tradeDate: true },
  });
  return row?.tradeDate ?? null;
}

interface BriefPayload {
  briefDate: string;
  dataDate: string; // 报告实际使用的交易日（早于 briefDate 时前端标注）
  type: 'morning' | 'daily';
  generatedAt: string;
  // 数据完整性标注（任一非空即前端显示提示条）
  dataIssues: string[];
  // 市场概况
  market: {
    upCount: number;
    downCount: number;
    avgChange: number | null;
    limitUp: number;
    limitDown: number;
    newHigh20: number | null;
    northMoney: number | null; // 万（数据停更时为 null，前端隐藏该卡）
  };
  // 板块资金（industry_moneyflow_ths，亿元）
  sectorFlow: {
    inflow: { name: string; net: number }[]; // 净流入 Top3
    outflow: { name: string; net: number }[]; // 净流出 Top3（净额由多到少）
  } | null;
  // 龙虎榜亮点
  dragonTiger: {
    orgNetBuy: { name: string; amount: number }[]; // 机构净买入 Top3
    hotMoneyNetBuy: { name: string; amount: number }[]; // 游资净买入 Top3
    hotRank: { name: string; rank: number }[]; // 人气 Top3
  } | null;
  // 昨日筛选表现（仅 daily：上一交易日入选、今日已回填 T+1）
  aiScreen: {
    strategy: string;
    picks: number;
    t1WinRate: number | null;
    best: { name: string; t1: number } | null;
    worst: { name: string; t1: number } | null;
  }[] | null;
  // 预警触发概况（仅 daily）
  alertTriggers: {
    total: number;
    top: { label: string; n: number }[]; // 触发 Top5 子信号
  } | null;
  // 今日关注（仅 morning 有）
  focus: {
    strongIndustries: string[]; // 昨日强势行业 Top3
    watchStocks: { name: string; reason: string }[]; // 昨日炸板/连板中断
  } | null;
  // 一句话总结（模板兜底；LLM 解读成功时 insight 优先展示）
  summary: string;
  // LLM 解读（失败/未配置为 null）
  insight: string | null;
}

/** 调 LLM 生成解读（非流式；任何失败返回 null，报告照常生成） */
async function callInsightLlm(prompt: string): Promise<string | null> {
  const cfg = getServerScreenCfg();
  if (!cfg) {
    console.warn('[daily-brief] AI_SCREEN_API_KEY 未配置，跳过 LLM 解读');
    return null;
  }
  const { signal, clear } = createTimeoutSignal(90_000);
  try {
    const res = await fetch(buildChatUrl(cfg.baseUrl), {
      method: 'POST',
      headers: buildLLMHeaders(cfg.apiKey),
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 400,
        stream: false,
      }),
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    return typeof text === 'string' && text.trim() ? text.trim() : null;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[daily-brief] LLM 解读失败: ${msg.slice(0, 80)}`);
    return null;
  } finally {
    clear();
  }
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
  // 数据日期：最近交易日（周一盘前 fallback 到上周五，避免空报告）
  const dataDate = await latestTradeDate(targetDate, typeArg);
  if (!dataDate) {
    console.error('[daily-brief] 无日线数据，无法生成');
    process.exit(1);
  }
  const dataIssues: string[] = [];
  if (typeArg === 'daily' && dataDate !== targetDate) {
    dataIssues.push(`当日日线未更新，报告基于最近交易日 ${dataDate.slice(4, 6)}-${dataDate.slice(6, 8)}`);
  }

  console.log(`[daily-brief] type=${typeArg} target=${targetDate} data=${dataDate}`);

  // ── 市场概况（dataDate 当日）────────────────────────────
  const bars = await prisma.dailyBar.findMany({
    where: { tradeDate: dataDate, changePct: { not: null } },
    select: { changePct: true },
  });
  if (bars.length < 2000) dataIssues.push(`日线数据疑似不完整（${bars.length} 行）`);
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
  if (!breadth) dataIssues.push('大盘宽度未更新（涨停/跌停数缺失）');
  const north = await prisma.northboundFlow.findUnique({
    where: { tradeDate: dataDate },
    select: { tradeDate: true, northMoney: true },
  });
  // 北向实时已停发：只认 dataDate 当日数据，旧数据不再顶替（避免展示过期数字）
  if (!north) dataIssues.push('北向资金数据未更新（已停发）');

  const market = {
    upCount,
    downCount,
    avgChange: avgChg != null ? Math.round(avgChg * 100) / 100 : null,
    limitUp: breadth?.limitUp ?? 0,
    limitDown: breadth?.limitDown ?? 0,
    newHigh20: breadth?.newHigh20 ?? null,
    northMoney: north?.northMoney ?? null,
  };

  // ── 板块资金（industry_moneyflow_ths，dataDate 当日）──────────
  let sectorFlow: BriefPayload['sectorFlow'] = null;
  try {
    const flows = await prisma.industryMoneyflowThs.findMany({
      where: { tradeDate: dataDate, netAmount: { not: null } },
      select: { industry: true, netAmount: true },
    });
    if (flows.length === 0) {
      dataIssues.push('板块资金数据缺失');
    } else {
      const sorted = [...flows].sort((a, b) => (b.netAmount ?? 0) - (a.netAmount ?? 0));
      const inflow = sorted.filter((f) => (f.netAmount ?? 0) > 0).slice(0, 3);
      const outflow = sorted.filter((f) => (f.netAmount ?? 0) < 0).slice(-3).reverse();
      sectorFlow = {
        inflow: inflow.map((f) => ({ name: f.industry ?? '', net: f.netAmount ?? 0 })),
        outflow: outflow.map((f) => ({ name: f.industry ?? '', net: f.netAmount ?? 0 })),
      };
    }
  } catch { dataIssues.push('板块资金数据缺失'); }

  // ── 龙虎榜（fuyao，dataDate 数据）────────────────────────────
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
    if (!orgTop.length && !hotTop.length && !rankTop.length) dataIssues.push('龙虎榜数据缺失');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[daily-brief] 龙虎榜拉取失败: ${msg.slice(0, 60)}`);
    dataIssues.push('龙虎榜数据缺失');
  }

  // ── 筛选表现（仅 daily：上一交易日入选、今日已回填 T+1）────────────
  let aiScreen: BriefPayload['aiScreen'] = null;
  if (typeArg === 'daily') {
    // 上一交易日（dataDate 之前的最近交易日）——当日 18:30 时"今日入选"的 T+1 尚未产生，恒空
    const prevTrade = await prisma.dailyBar.findFirst({
      where: { tradeDate: { lt: dataDate } },
      orderBy: { tradeDate: 'desc' },
      select: { tradeDate: true },
    });
    if (prevTrade) {
      const runs = await prisma.aiScreenRun.findMany({
        where: { barDate: prevTrade.tradeDate },
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
  }

  // ── 预警触发概况（仅 daily：dataDate 当日触发的规则 Top5）──────────
  let alertTriggers: BriefPayload['alertTriggers'] = null;
  if (typeArg === 'daily') {
    const triggers = await prisma.alertRuleTrigger.findMany({
      where: { barDate: dataDate },
      select: { subLabel: true },
    });
    if (triggers.length > 0) {
      const count = new Map<string, number>();
      for (const t of triggers) count.set(t.subLabel, (count.get(t.subLabel) ?? 0) + 1);
      alertTriggers = {
        total: triggers.length,
        top: [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([label, n]) => ({ label, n })),
      };
    }
  }

  // ── 今日关注（仅 morning：昨日强势行业 + 炸板/连板中断标的）────────────
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

    // 炸板/连板中断（limit_list_d Z 组：昨日开板未回封；连板数≥2 即连板中断）
    // 分歧最大的排前（open_times 多 → 连板数高）
    const watchStocks: { name: string; reason: string }[] = [];
    try {
      const rows = await getLimitListD(dataDate);
      const broken = rows
        .filter((r) => r.limit === 'Z')
        .sort((a, b) => ((b.open_times ?? 0) - (a.open_times ?? 0)) || ((b.limit_times ?? 0) - (a.limit_times ?? 0)))
        .slice(0, 5);
      for (const r of broken) {
        const times = r.limit_times ?? 1;
        watchStocks.push({
          name: r.name ?? '',
          reason: times >= 2 ? `${times}连板中断` : '涨停炸板',
        });
      }
      if (watchStocks.length === 0) dataIssues.push('炸板数据缺失（当日无炸板或数据未更新）');
    } catch {
      dataIssues.push('炸板数据缺失');
    }

    focus = { strongIndustries, watchStocks };
  }

  // ── 一句话总结（模板兜底，LLM 解读失败时前端展示这个）────────────
  const marketTone = avgChg != null ? (avgChg > 0.5 ? '强势' : avgChg > 0 ? '偏强' : avgChg > -0.5 ? '偏弱' : '弱势') : '数据不足';
  const summary = typeArg === 'morning'
    ? `昨日市场${marketTone}，涨 ${upCount}/跌 ${downCount}，涨停 ${market.limitUp} 家。${dragonTiger?.orgNetBuy[0] ? `机构净买入 ${dragonTiger.orgNetBuy[0].name}。` : ''}今日关注：${focus?.strongIndustries.join('、') ?? '无'}。`
    : `今日市场${marketTone}，涨 ${upCount}/跌 ${downCount}，涨停 ${market.limitUp} 家。${aiScreen?.[0] ? `${aiScreen[0].strategy} T+1 胜率 ${aiScreen[0].t1WinRate}%。` : ''}`;

  const payload: BriefPayload = {
    briefDate: targetDate,
    dataDate,
    type: typeArg,
    generatedAt: new Date().toISOString(),
    dataIssues,
    market,
    sectorFlow,
    dragonTiger,
    aiScreen,
    alertTriggers,
    focus,
    summary,
    insight: null,
  };

  // ── LLM 解读（失败回退模板 summary）────────────────────────────
  const typeLabel = typeArg === 'morning' ? '盘前提示（基于昨日数据）' : '盘后日报（基于当日数据）';
  const issueText = dataIssues.length ? `数据说明：${dataIssues.join('；')}` : '数据完整';
  const flowText = sectorFlow
    ? `板块资金（亿元）：流入 ${sectorFlow.inflow.map((f) => `${f.name} ${f.net.toFixed(1)}`).join('、') || '无'}；流出 ${sectorFlow.outflow.map((f) => `${f.name} ${f.net.toFixed(1)}`).join('、') || '无'}`
    : '板块资金：无数据';
  const dtText = dragonTiger
    ? `龙虎榜：机构净买入 ${dragonTiger.orgNetBuy.map((s) => `${s.name} ${s.amount.toFixed(1)}亿`).join('、') || '无'}；游资净买入 ${dragonTiger.hotMoneyNetBuy.map((s) => `${s.name} ${s.amount.toFixed(1)}亿`).join('、') || '无'}；人气 ${dragonTiger.hotRank.map((s) => s.name).join('、') || '无'}`
    : '龙虎榜：无数据';
  const focusText = typeArg === 'morning' && focus
    ? `今日关注：强势行业 ${focus.strongIndustries.join('、')}；炸板/连板中断标的 ${focus.watchStocks.map((s) => `${s.name}（${s.reason}）`).join('、') || '无'}`
    : '';
  const perfText = typeArg === 'daily'
    ? `${aiScreen && aiScreen.length ? `筛选表现（上一交易日 T+1）：${aiScreen.map((s) => `${s.strategy} 胜率${s.t1WinRate ?? '--'}%（${s.picks}只${s.best ? `，最佳 ${s.best.name}` : ''}）`).join('；')}` : '筛选表现：无数据'}。${alertTriggers ? `预警触发 ${alertTriggers.total} 次：${alertTriggers.top.map((t) => `${t.label}×${t.n}`).join('、')}` : '预警触发：无数据'}.`
    : '';
  const prompt = [
    `你是个人投资工具的市场报告解读助手，负责${typeLabel}。`,
    `只基于下列数据解读，不得编造任何数字或事实；禁止推荐任何具体标的；用「标的」一词代替「股票」；不喊单、不煽动情绪。`,
    ``,
    `市场概况：涨 ${upCount} / 跌 ${downCount}，平均 ${pct(avgChg)}，涨停 ${market.limitUp} / 跌停 ${market.limitDown}${market.newHigh20 != null ? `，20日新高 ${market.newHigh20}` : ''}${market.northMoney != null ? `，北向净流入 ${(market.northMoney / 10000).toFixed(1)} 亿` : ''}。`,
    `${issueText}。`,
    flowText + '。',
    dtText + '。',
    focusText,
    perfText,
    ``,
    `要求：输出 3-5 句连贯解读（不用小标题、不用列表、不用 markdown），回答「${typeArg === 'morning' ? '昨日发生了什么、今天要注意什么' : '今日市场怎么样、策略与预警表现如何'}」，语气克制客观。`,
  ].filter(Boolean).join('\n');
  const insight = await callInsightLlm(prompt);
  payload.insight = insight;

  await prisma.dailyBrief.upsert({
    where: { briefDate_type: { briefDate: targetDate, type: typeArg } },
    create: { briefDate: targetDate, type: typeArg, payload: JSON.stringify(payload), createdAt: new Date().toISOString() },
    update: { payload: JSON.stringify(payload), createdAt: new Date().toISOString() },
  });

  console.log(`[daily-brief] 已生成 ${typeArg} ${targetDate}（数据日 ${dataDate}，issues: ${dataIssues.length}，insight: ${insight ? '有' : '无'}）`);
  console.log(insight ?? summary);
  await prisma.$disconnect();
}

main().catch((e) => { console.error('[daily-brief] 失败:', e); process.exit(1); });
