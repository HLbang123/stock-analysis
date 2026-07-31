/**
 * POST /api/ai-screen  — 跑一次 AI 筛选（去重 + 降级补救）
 * GET  /api/ai-screen  — 列出历史运行
 *
 * 去重：同策略同数据日只存一条权威 Run，第一个跑的人花 token，后面的人秒取缓存。
 * 补救：若首跑 LLM 失败回退纯规则，后续带可用 token 的用户会自动重跑一次 LLM 升级结果
 *      （每天每策略最多补救1次，熔断防烧 token）。所有路径返回结构一致，不暴露"谁先跑"。
 *
 * 对外文案用「筛选」，合规口径。LLM 配置由前端传入。
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { STRATEGY_PRESETS, getPreset } from '@/services/ai-screen/strategies';
import { runScreen, rescueRun, dbPickToAiPick } from '@/services/ai-screen/engine';
import type { AiPick, AiScreenRun, LlmConfig } from '@/services/ai-screen/types';

/** 质量门控：只有 DeepSeek v4 及以上模型跑的结果才落库成为全员共享缓存。
 *  非 DeepSeek 或低于 v4 的用户：有合格缓存则白嫖，无缓存则用自己模型跑一次性结果给他看（不落库）。
 *  版本取模型名里的 vN（如 deepseek-v4-flash → 4），无版本号的（如 deepseek-chat / deepseek-r1）保守不计。 */
const isPreferredModel = (m?: string): boolean => {
  if (!m) return false;
  const lower = m.toLowerCase();
  if (!lower.includes('deepseek')) return false;
  const vm = lower.match(/v(\d+)/);
  if (!vm) return false;
  return parseInt(vm[1], 10) >= 4;
};

/** AiPick → Prisma pick create 数据(全候选落库;非入选 selected=false/rank=null) */
function pickToCreate(k: AiPick) {
  return {
    selected: k.selected,
    rank: k.selected ? k.rank : null,
    tsCode: k.tsCode,
    name: k.name,
    industry: k.industry,
    rps: k.rps,
    latestClose: k.latestClose,
    latestChange: k.latestChange,
    latestAmount: k.latestAmount,
    ret60d: k.ret60d,
    macdStatus: k.macdStatus,
    rsiStatus: k.rsiStatus,
    volatility20d: k.volatility20d,
    maxDrawdown20d: k.maxDrawdown20d,
    atr20: k.atr20,
    volumeRatio: k.volumeRatio,
    signalScore: k.signalScore,
    maBullish: k.maBullish,
    pullbackToMa20Pct: k.pullbackToMa20Pct,
    breakout20dPct: k.breakout20dPct,
    roe: k.roe,
    grossprofitMargin: k.grossprofitMargin,
    orYoy: k.orYoy,
    industryChangePct: k.industryChangePct,
    factorScores: k.factorScores as any,
    screenScore: k.screenScore,
    llmScore: k.llmScore,
    llmConfidence: k.llmConfidence,
    finalScore: k.finalScore,
    llmSector: k.llmSector || null,
    llmTheme: k.llmTheme || null,
    llmThesis: k.llmThesis || null,
    rankingReason: k.rankingReason || null,
    riskSummary: k.riskSummary || null,
    llmCatalysts: k.llmCatalysts,
    llmRisks: k.llmRisks,
    llmTags: k.llmTags,
    llmStyleFit: k.llmStyleFit || null,
    llmWatchItems: k.llmWatchItems,
    llmInvalidators: k.llmInvalidators,
    riskScore: k.riskScore,
    riskLevel: k.riskLevel,
    riskPenalty: k.riskPenalty,
    riskFlags: k.riskFlags,
    portfolioPenalty: k.portfolioPenalty,
    entryPrice: k.entryPrice,
    entryDate: k.entryDate,
  };
}

/** 补救成功后,AiPick → 需更新的字段(仅入选 top-N) */
function pickToUpdate(k: AiPick) {
  return {
    selected: true,
    rank: k.rank,
    llmScore: k.llmScore,
    llmConfidence: k.llmConfidence,
    finalScore: k.finalScore,
    llmSector: k.llmSector || null,
    llmTheme: k.llmTheme || null,
    llmThesis: k.llmThesis || null,
    rankingReason: k.rankingReason || null,
    riskSummary: k.riskSummary || null,
    llmCatalysts: k.llmCatalysts,
    llmRisks: k.llmRisks,
    llmTags: k.llmTags,
    llmStyleFit: k.llmStyleFit || null,
    llmWatchItems: k.llmWatchItems,
    llmInvalidators: k.llmInvalidators,
    riskScore: k.riskScore,
    riskLevel: k.riskLevel,
    riskPenalty: k.riskPenalty,
    riskFlags: k.riskFlags,
    portfolioPenalty: k.portfolioPenalty,
  };
}

/** 展示用:只取入选行(rank!=null,兼容历史数据——旧 run 全员有 rank,新 run 仅 top-N 有 rank) */
const displayPicks = (rows: any[]) => rows.filter((p: any) => p.rank != null).map(dbPickToAiPick);

/** DB Run 行 → AiScreenRun（前端用） */
function serializeRun(r: any): AiScreenRun {
  return {
    id: r.id,
    strategyId: r.strategyId,
    strategyName: r.strategyName,
    createdAt: r.createdAt,
    barDate: r.barDate,
    rpsPeriod: r.rpsPeriod,
    candidateCount: r.candidateCount,
    pickCount: r.pickCount,
    llmReranked: r.llmReranked,
    llmModel: r.llmModel,
    llmMarketView: r.llmMarketView || '',
    llmSelectionLogic: r.llmSelectionLogic || '',
    llmPortfolioRisk: r.llmPortfolioRisk || '',
    llmCoverage: r.llmCoverage,
    degradation: r.degradation ?? [],
    riskEnabled: r.riskEnabled,
    portfolioEnabled: r.portfolioEnabled,
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { strategyId, baseUrl, apiKey, model } = body as { strategyId: string } & LlmConfig;

    const preset = getPreset(strategyId);
    if (!preset) {
      return NextResponse.json({ error: `未知策略：${strategyId}` }, { status: 400 });
    }

    const cfg: LlmConfig | undefined = baseUrl && model ? { baseUrl, apiKey, model } : undefined;
    if (preset.llmRerank && !cfg) {
      return NextResponse.json({ error: '该策略启用 LLM 重排，需提供 baseUrl / model' }, { status: 400 });
    }

    // 取最新数据日（去重 key 的一部分）
    const latestBar = await prisma.dailyBar.findFirst({ orderBy: { tradeDate: 'desc' }, select: { tradeDate: true } });
    if (!latestBar) {
      return NextResponse.json({ error: '无可用日线数据' }, { status: 500 });
    }
    const barDate = latestBar.tradeDate;

    // 查是否已有当日同策略的 Run
    const existing = await prisma.aiScreenRun.findUnique({
      where: { strategyId_barDate: { strategyId: preset.id, barDate } },
      include: { picks: { orderBy: { rank: 'asc' } } },
    });

    if (existing) {
      // 好结果（已 AI 重排 或 策略本身不用 LLM）→ 直接返回缓存
      if (!preset.llmRerank || existing.llmReranked) {
        return NextResponse.json({ run: serializeRun(existing), picks: displayPicks(existing.picks) });
      }
      // 降级结果 + 调用方是 DeepSeek + 过了 10 分钟冷却 → 用调用方 token 补救一次
      // 冷却窗口防止偶发超时后每个用户都干等 1-4 分钟生成 + 烧 token；CAS 抢占防并发补救写库竞争
      const RESCUE_COOLDOWN_MS = 10 * 60 * 1000;
      const nowIso = new Date().toISOString();
      const tooSoon =
        !!existing.llmRescuedAt &&
        Date.now() - new Date(existing.llmRescuedAt).getTime() < RESCUE_COOLDOWN_MS;
      if (cfg && isPreferredModel(cfg.model) && !tooSoon) {
        // CAS 抢占：只有 llmRescuedAt 仍是旧值/null 的请求能继续，并发请求 count===0 直接返回
        const claimed = await prisma.aiScreenRun.updateMany({
          where: { id: existing.id, llmRescuedAt: existing.llmRescuedAt },
          data: { llmRescuedAt: nowIso },
        });
        if (claimed.count === 1) {
          const idByCode = new Map(existing.picks.map((p) => [p.tsCode, p.id]));
          const dbPicks = existing.picks.map(dbPickToAiPick);
          const outcome = await rescueRun(dbPicks, preset, cfg);
          if (outcome) {
            // 补救成功：更新 Run + 清空全部候选的 selected/rank + 重标 top-N
            await prisma.$transaction([
              prisma.aiScreenRun.update({
                where: { id: existing.id },
                data: {
                  llmReranked: true,
                  llmRescued: true,
                  llmModel: cfg.model,
                  llmMarketView: outcome.marketView || null,
                  llmSelectionLogic: outcome.selectionLogic || null,
                  llmPortfolioRisk: outcome.portfolioRisk || null,
                  llmCoverage: outcome.coverage,
                  degradation: [...(existing.degradation ?? []), ...outcome.degradation, 'rescued_by_later_token'],
                },
              }),
              prisma.aiScreenPick.updateMany({
                where: { runId: existing.id },
                data: { selected: false, rank: null },
              }),
              ...outcome.picks
                .map((k) => ({ id: idByCode.get(k.tsCode), data: pickToUpdate(k) }))
                .filter((u): u is { id: string; data: any } => !!u.id)
                .map((u) => prisma.aiScreenPick.update({ where: { id: u.id }, data: u.data })),
            ]);
            const refreshed = await prisma.aiScreenRun.findUnique({
              where: { id: existing.id },
              include: { picks: { orderBy: { rank: 'asc' } } },
            });
            return NextResponse.json({ run: serializeRun(refreshed), picks: displayPicks(refreshed!.picks) });
          }
          // 补救仍失败：llmRescuedAt 已在 CAS 时置为 nowIso，10 分钟冷却已开启，返回降级结果（不再永久熔断，10 分钟后可再试）
          return NextResponse.json({ run: serializeRun({ ...existing, llmRescuedAt: nowIso }), picks: displayPicks(existing.picks) });
        }
        // 没抢到（并发被别的请求抢先补救）：返回当前结果
        return NextResponse.json({ run: serializeRun(existing), picks: displayPicks(existing.picks) });
      }
      // 冷却中 / 无 token / 非 DeepSeek → 返回现有降级结果
      return NextResponse.json({ run: serializeRun(existing), picks: displayPicks(existing.picks) });
    }

    // 无缓存：首跑。runScreen 内部已含 LLM 重排 + 风险 + 组合
    const { run, candidates, picks } = await runScreen(preset, cfg);

    // 质量门控：LLM 策略只有 DeepSeek 模型跑的结果才落库共享；非 DeepSeek 用户跑的一次性结果只返回给他看，不落库。
    // 非 LLM 策略（纯规则）无模型质量差异，首跑即落库。
    const shouldPersist = !preset.llmRerank || isPreferredModel(cfg?.model);
    if (!shouldPersist) {
      return NextResponse.json({ run, picks });
    }

    try {
      await prisma.aiScreenRun.create({
        data: {
          id: run.id,
          strategyId: run.strategyId,
          strategyName: run.strategyName,
          createdAt: run.createdAt,
          barDate: run.barDate,
          rpsPeriod: run.rpsPeriod,
          candidateCount: run.candidateCount,
          pickCount: run.pickCount,
          llmReranked: run.llmReranked,
          llmRescued: false,
          llmModel: run.llmModel,
          llmMarketView: run.llmMarketView || null,
          llmSelectionLogic: run.llmSelectionLogic || null,
          llmPortfolioRisk: run.llmPortfolioRisk || null,
          llmCoverage: run.llmCoverage,
          degradation: run.degradation,
          riskEnabled: run.riskEnabled,
          portfolioEnabled: run.portfolioEnabled,
          picks: { create: candidates.map(pickToCreate) },
        },
      });
    } catch (e: any) {
      // 并发：另一个用户刚建了同策略当日 Run → 取他的
      if (e?.code === 'P2002') {
        const r = await prisma.aiScreenRun.findUnique({
          where: { strategyId_barDate: { strategyId: preset.id, barDate } },
          include: { picks: { orderBy: { rank: 'asc' } } },
        });
        if (r) return NextResponse.json({ run: serializeRun(r), picks: displayPicks(r.picks) });
      }
      throw e;
    }
    return NextResponse.json({ run, picks });
  } catch (e: any) {
    console.error('[api/ai-screen POST]', e);
    return NextResponse.json({ error: e.message || 'AI 筛选失败' }, { status: 500 });
  }
}

export async function GET() {
  try {
    const runs = await prisma.aiScreenRun.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        strategyId: true,
        strategyName: true,
        createdAt: true,
        barDate: true,
        rpsPeriod: true,
        candidateCount: true,
        pickCount: true,
        llmReranked: true,
        llmRescued: true,
        llmModel: true,
        llmCoverage: true,
        degradation: true,
      },
    });
    return NextResponse.json({
      strategies: STRATEGY_PRESETS.map((s) => ({ id: s.id, name: s.name, description: s.description, category: s.category, rulesText: s.rulesText })),
      runs,
    });
  } catch (e: any) {
    console.error('[api/ai-screen GET]', e);
    return NextResponse.json({ error: e.message || '查询历史失败' }, { status: 500 });
  }
}
