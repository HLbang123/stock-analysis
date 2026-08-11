/**
 * AI 筛选 — 落库与序列化（API 路由与每日调度脚本共用，防两处漂移）
 *
 * 从 app/api/ai-screen/route.ts 抽出：pickToCreate / serializeRun / persistRun。
 * 路由保留并发控制（in-flight 去重 / P2002 兜底 / 补救熔断），脚本走简单路径。
 */

import { prisma } from '@/lib/db';
import type { AiPick, AiScreenRun } from './types';

/** AiPick → Prisma pick create 数据(全候选落库;非入选 selected=false/rank=null) */
export function pickToCreate(k: AiPick) {
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

/** 一次运行落库（含全部候选）；已存在同策略同日 run 时需调用方先删（脚本用）或捕获 P2002（路由用） */
export async function persistRun(run: AiScreenRun, candidates: AiPick[]): Promise<void> {
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
}

/** DB Run 行 → AiScreenRun（前端用） */
export function serializeRun(r: any): AiScreenRun {
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
