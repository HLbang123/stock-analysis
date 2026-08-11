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
import { getServerScreenCfg } from '@/services/ai-screen/server-cfg';
import { persistRun, serializeRun, pickToCreate } from '@/services/ai-screen/persist';
import type { AiPick, AiScreenRun, LlmConfig, StrategyPreset } from '@/services/ai-screen/types';

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

/** 展示用:只取入选行(rank!=null,兼容历史数据——旧 run 全员有 rank,新 run 仅 top-N 有 rank) */
const displayPicks = (rows: any[]) => rows.filter((p: any) => p.rank != null).map(dbPickToAiPick);

/** 补救成功后,AiPick → 需更新的字段(仅入选 top-N 才 selected=true/rank 有值；未入选 rank=null，displayPicks 据此过滤) */
function pickToUpdate(k: AiPick) {
  return {
    selected: k.selected,
    rank: k.selected ? k.rank : null,
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

// ── 跨用户补救熔断：连续失败后 6h 内不再补救（DeepSeek 故障日防无限烧 token）──
const rescueCircuit = new Map<string, { failures: number; blockedAt: number }>();
const RESCUE_CIRCUIT_MAX = 3;
const RESCUE_CIRCUIT_TTL_MS = 6 * 3600 * 1000;
const circuitKey = (strategyId: string, barDate: string) => `${strategyId}_${barDate}`;
function isRescueCircuited(key: string): boolean {
  const c = rescueCircuit.get(key);
  return !!c && c.failures >= RESCUE_CIRCUIT_MAX && Date.now() - c.blockedAt < RESCUE_CIRCUIT_TTL_MS;
}
function recordRescueFailure(key: string): void {
  const c = rescueCircuit.get(key) ?? { failures: 0, blockedAt: Date.now() };
  c.failures += 1;
  c.blockedAt = Date.now();
  rescueCircuit.set(key, c);
}
function clearRescueCircuit(key: string): void {
  rescueCircuit.delete(key);
}

// ── 首跑 in-flight 去重：同策略同数据日的并发请求共享同一次执行 ──
// （客户端断网自动重试/双击/多用户同时首跑时，不会重复跑 runScreen 烧 token）
const firstRunInflight = new Map<string, Promise<{ run: AiScreenRun; picks: AiPick[] }>>();

/** 首跑执行体：runScreen + 按质量门控落库；P2002 并发兜底取对方结果。
 *  trusted=true（服务器 key 跑）→ 无条件落库共享；否则走旧质量门控（仅 DeepSeek v4+ 落库） */
async function runFirstRun(preset: StrategyPreset, cfg?: LlmConfig, trusted = false): Promise<{ run: AiScreenRun; picks: AiPick[] }> {
  // 无缓存：首跑。runScreen 内部已含 LLM 重排 + 风险 + 组合
  const { run, candidates, picks } = await runScreen(preset, cfg);

  // 质量门控：服务器 key（trusted）无条件落库；用户 key 只有 DeepSeek 模型的结果才落库共享。
  // 非 LLM 策略（纯规则）无模型质量差异，首跑即落库。
  const shouldPersist = trusted || !preset.llmRerank || isPreferredModel(cfg?.model);
  if (!shouldPersist) {
    return { run, picks };
  }

  try {
    await persistRun(run, candidates);
  } catch (e: any) {
    // 并发：另一个用户刚建了同策略当日 Run → 取他的
    if (e?.code === 'P2002') {
      const r = await prisma.aiScreenRun.findUnique({
        where: { strategyId_barDate: { strategyId: preset.id, barDate: run.barDate } },
        include: { picks: { orderBy: { rank: 'asc' } } },
      });
      if (r) return { run: serializeRun(r), picks: displayPicks(r.picks) };
    }
    throw e;
  }
  return { run, picks };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { strategyId, baseUrl, apiKey, model } = body as { strategyId: string } & LlmConfig;

    const preset = getPreset(strategyId);
    if (!preset) {
      return NextResponse.json({ error: `未知策略：${strategyId}` }, { status: 400 });
    }

    // 服务器 key 优先（每日调度共用）；未配置时回退客户端配置（旧 AI 页路径）
    const serverCfg = getServerScreenCfg();
    const cfg: LlmConfig | undefined = serverCfg ?? (baseUrl && model ? { baseUrl, apiKey, model } : undefined);
    if (preset.llmRerank && !cfg) {
      return NextResponse.json({ error: '该策略启用 LLM 重排，需提供 baseUrl / model（或服务器配置 AI_SCREEN_API_KEY）' }, { status: 400 });
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
      // 降级结果 + 调用方是 DeepSeek + 过了 10 分钟冷却 + 未熔断 → 用调用方 token 续打一次（增量续打）
      // 冷却窗口防止偶发超时后每个用户都干等 1-4 分钟生成 + 烧 token；CAS 抢占防并发写库竞争
      const RESCUE_COOLDOWN_MS = 10 * 60 * 1000;
      const nowIso = new Date().toISOString();
      const tooSoon =
        !!existing.llmRescuedAt &&
        Date.now() - new Date(existing.llmRescuedAt).getTime() < RESCUE_COOLDOWN_MS;
      const cKey = circuitKey(preset.id, barDate);
      if (cfg && isPreferredModel(cfg.model) && !tooSoon && !isRescueCircuited(cKey)) {
        // CAS 抢占：只有 llmRescuedAt 仍是旧值/null 的请求能继续，并发请求 count===0 直接返回
        const claimed = await prisma.aiScreenRun.updateMany({
          where: { id: existing.id, llmRescuedAt: existing.llmRescuedAt },
          data: { llmRescuedAt: nowIso },
        });
        if (claimed.count === 1) {
          const idByCode = new Map(existing.picks.map((p) => [p.tsCode, p.id]));
          const dbPicks = existing.picks.map(dbPickToAiPick);
          const outcome = await rescueRun(dbPicks, preset, cfg).catch((e: any) => {
            console.error('[api/ai-screen rescue]', e);
            recordRescueFailure(cKey);
            return null;
          });
          if (outcome && outcome.matched > 0) {
            // 有产出（部分保留或完成）→ 全量写库：清 selected/rank + 更新全部候选 + run 字段
            // completed=true → llmReranked=true（共享缓存开启）；部分保留 → 保持 false，后续续打
            await prisma.$transaction([
              prisma.aiScreenRun.update({
                where: { id: existing.id },
                data: {
                  llmReranked: outcome.completed,
                  llmRescued: outcome.completed,
                  llmModel: cfg.model,
                  llmMarketView: outcome.marketView || null,
                  llmSelectionLogic: outcome.selectionLogic || null,
                  llmPortfolioRisk: outcome.portfolioRisk || null,
                  llmCoverage: outcome.coverage,
                  degradation: [
                    ...(existing.degradation ?? []),
                    ...outcome.degradation,
                    outcome.completed ? 'rescued_by_later_token' : 'partial_kept_by_later_token',
                  ],
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
            if (outcome.completed) {
              clearRescueCircuit(cKey);
            } else {
              // 部分保留也算一次失败计数（烧了 token 但未完成），防 DeepSeek 故障日持续烧
              recordRescueFailure(cKey);
            }
            const refreshed = await prisma.aiScreenRun.findUnique({
              where: { id: existing.id },
              include: { picks: { orderBy: { rank: 'asc' } } },
            });
            return NextResponse.json({ run: serializeRun(refreshed), picks: displayPicks(refreshed!.picks) });
          }
          // 无产出（LLM 全空/调用失败）：熔断计数 + llmRescuedAt 已在 CAS 时置为 nowIso（10 分钟冷却已开），返回现有降级结果
          recordRescueFailure(cKey);
          return NextResponse.json({ run: serializeRun({ ...existing, llmRescuedAt: nowIso }), picks: displayPicks(existing.picks) });
        }
        // 没抢到（并发被别的请求抢先补救）：返回当前结果
        return NextResponse.json({ run: serializeRun(existing), picks: displayPicks(existing.picks) });
      }
      // 冷却中 / 熔断中 / 无 token / 非 DeepSeek → 返回现有结果（部分保留的分已生效，llmScore 非空即展示）
      return NextResponse.json({ run: serializeRun(existing), picks: displayPicks(existing.picks) });
    }

    // 无缓存：首跑（in-flight 去重——并发/自动重试的请求共享同一次执行，防重复烧 token）
    const flightKey = circuitKey(preset.id, barDate);
    const pending = firstRunInflight.get(flightKey);
    if (pending) {
      try {
        return NextResponse.json(await pending);
      } catch {
        // 在途执行失败则落到下方自己跑一遍（重新占位）
      }
    }
    const task = runFirstRun(preset, cfg, !!serverCfg);
    firstRunInflight.set(flightKey, task);
    try {
      return NextResponse.json(await task);
    } finally {
      // 仅当 map 里仍是自己的任务才删——在途任务失败后新任务覆盖了占位，旧请求的 finally 不得误删
      if (firstRunInflight.get(flightKey) === task) firstRunInflight.delete(flightKey);
    }
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
