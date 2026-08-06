/**
 * 深度分析 — 三阶段(情报→辩论→裁决)的数据准备、SSE 流解析与结果落库。
 * 从 app/ai/page.tsx 抽出，页面只保留编排与状态。
 */

import type { RealtimeQuote } from '@/types';
import type { Stock } from '@/types';
import type { AiAnalysisRecord } from '@/store/ai-store';
import type { TradeLevels, MarketRegime } from '@/services/deep-analysis/levels';
import type { ChipDistribution } from '@/lib/chip';
import type { LlmConfig } from '@/services/ai-screen/types';
import {
  buildAnalystSystemPrompt, buildAnalystUserPrompt,
  buildVerdictSystemPrompt, buildVerdictUserPrompt,
  buildReflectionContext, buildDebateDataPrompt,
  buildTechR1SystemPrompt, buildRiskR1SystemPrompt, buildXinJieR1DebatePrompt,
  buildTechR2RebuttalPrompt, buildRiskR2RebuttalPrompt, buildXinJieR2RebuttalPrompt,
  buildManagerPrompt,
} from '@/services/deepAnalysisPrompt';
import { computeKeyLevels, formatLevelsForPrompt } from '@/services/deep-analysis/levels';
import { calculateIndicators, formatIndicatorsForPrompt } from '@/lib/indicators';
import { buildUpdatedKLines } from '@/lib/stock-helpers';
import { checkAllRules, ALERT_RULES } from '@/services/alertRules';
import { getIndustry, getRealtimeQuoteCached, getKLineSinaCached, getChipData, fetchMarketStatusNote } from '@/services/stockApi';
import { fetchTushareData, formatTushareForPrompt } from '@/services/tushareData';
import { getJSONOr, postJSON, getJSON } from '@/services/api';
import { streamChatDirect, LlmHttpError, isDirectConnectionError } from '@/services/llm/browser-client';
import type { StockRpsResp, BreadthResp, FuyaoFundResp } from '@/types/api';
import { isETF } from '@/lib/identify';

// ── 结构化裁决结果（verdict 文本解析）─────────────────────────────────
export interface DeepStructured {
  action: string;
  oneLiner?: string;
  riskLevel: string;
  confidence: number;
  targetLow: number;
  targetHigh: number;
  stopLoss: number;
  position: number;
  reasoning: string;
  plan: string;
  riskNote: string;
  confidenceScore?: number;
  clamped?: string[];
  keyPoints?: string[];
}

export interface DeepLevels {
  current: number;
  supports: { price: number; label: string }[];
  resistances: { price: number; label: string }[];
}

export interface DeepResult {
  analyst: string;
  analystReasoning?: string;
  debate: string;
  debateReasoning?: string;
  debateError?: string;
  verdict: string;
  verdictReasoning?: string;
  verdictError?: string;
  levels?: DeepLevels | null;
  structured: DeepStructured | null;
}

export type DeepStage = 'idle' | 'analyst' | 'debate' | 'verdict';

export interface DeepProgress {
  stage: DeepStage;
  result: DeepResult;
}

/** 解析 verdict 文本为结构化字段；levels 传入时对目标价/止损/仓位做越界夹紧 */
export function parseVerdictContent(text: string, levels?: TradeLevels | null): DeepStructured {
  const actionMatch = text.match(/ACTION:(.+)/);
  const oneLinerMatch = text.match(/ONE_LINER:(.+)/);
  const riskMatch = text.match(/RISK_LEVEL:(.+)/);
  const confMatch = text.match(/CONFIDENCE:\s*(\d+)/);
  const confValue = confMatch ? parseInt(confMatch[1]) : 0;
  const confScoreValue = confValue / 100;
  const targetLowMatch = text.match(/TARGET_LOW:(.+)/);
  const targetHighMatch = text.match(/TARGET_HIGH:(.+)/);
  const stopMatch = text.match(/STOP_LOSS:(.+)/);
  const posMatch = text.match(/POSITION:(.+)/);
  const keyPointsMatch = text.match(/KEY_POINTS:\s*(.+)/);

  const bodySplit = text.split(/^---[\r\n]+/m);
  let body = bodySplit.length > 1 ? bodySplit.slice(1).join('---\n') : text;
  body = body.replace(/^(ONE_LINER|ACTION|RISK_LEVEL|CONFIDENCE(_SCORE)?|TARGET_LOW|TARGET_HIGH|STOP_LOSS|POSITION|KEY_POINTS):.*$/gm, '').replace(/\n{3,}/g, '\n\n').trim();

  let reasoning = body, plan = '', riskNote = '';
  const planIdx = body.indexOf('### 操作计划');
  const riskIdx = body.indexOf('### 风险提示');
  if (planIdx >= 0) {
    reasoning = body.slice(0, planIdx).replace(/^###\s*决策理由\s*\n?/m, '').trim();
    if (riskIdx >= 0) {
      plan = body.slice(planIdx, riskIdx).replace(/^###\s*操作计划\s*\n?/m, '').trim();
      riskNote = body.slice(riskIdx).replace(/^###\s*风险提示\s*\n?/m, '').trim();
    } else {
      plan = body.slice(planIdx).replace(/^###\s*操作计划\s*\n?/m, '').trim();
    }
  } else {
    reasoning = body.replace(/^###\s*决策理由\s*\n?/m, '').trim();
  }

  const clamped: string[] = [];
  const toNum = (raw: string | undefined): number => {
    const v = parseFloat((raw || '').replace(/[^\d.]/g, ''));
    return Number.isFinite(v) ? v : NaN;
  };
  const clamp = (v: number, lo: number, hi: number, label: string): number => {
    if (!Number.isFinite(v)) return lo;
    if (v < lo) { clamped.push(`${label}:${v.toFixed(2)}→${lo.toFixed(2)}`); return lo; }
    if (v > hi) { clamped.push(`${label}:${v.toFixed(2)}→${hi.toFixed(2)}`); return hi; }
    return v;
  };

  const tR = levels?.targetRange, sR = levels?.stopLossRange, pR = levels?.positionRange;
  const targetLow = tR ? clamp(toNum(targetLowMatch?.[1]), tR.low, tR.high, 'target_low') : toNum(targetLowMatch?.[1]);
  const targetHigh = tR ? clamp(toNum(targetHighMatch?.[1]), tR.low, tR.high, 'target_high') : toNum(targetHighMatch?.[1]);
  const stopLoss = sR ? clamp(toNum(stopMatch?.[1]), sR.low, sR.high, 'stop_loss') : toNum(stopMatch?.[1]);
  const position = pR ? clamp(toNum(posMatch?.[1]), pR.low, pR.high, 'position') : toNum(posMatch?.[1]);

  return {
    action: actionMatch?.[1]?.trim() || '',
    oneLiner: oneLinerMatch?.[1]?.trim() || '',
    riskLevel: riskMatch?.[1]?.trim() || '',
    confidence: parseInt(confMatch?.[1]?.trim() || '0'),
    targetLow, targetHigh, stopLoss, position,
    reasoning, plan, riskNote,
    confidenceScore: confScoreValue,
    clamped,
    keyPoints: keyPointsMatch ? keyPointsMatch[1].split('|').map(p => p.trim()).filter(p => p.length > 0) : [],
  };
}

// ── 数据准备（抓行情/K线/筹码 + 算指标 + 拼三阶段 prompt）──────────────
export interface DeepContext {
  stockCode: string;
  stage1: { systemPrompt: string; userPrompt: string };
  stage2: { systemPrompt: string; userPrompt: string };
  stage3: { systemPrompt: string; userPrompt: string };
  tradeLevels: TradeLevels;
  marketRegime: MarketRegime;
  tushareIssues: string[];
  entryDate: string;
  quote: RealtimeQuote;
}

export async function prepareDeepContext(
  selectedCode: string,
  stock: Stock,
  history: AiAnalysisRecord[],
): Promise<DeepContext> {
  const [quote, kLines, tushareData, rpsRes, breadthRes] = await Promise.all([
    getRealtimeQuoteCached(selectedCode),
    getKLineSinaCached(selectedCode, 240, 120),
    fetchTushareData(selectedCode).catch(async () => {
      await new Promise(r => setTimeout(r, 2000));
      return fetchTushareData(selectedCode).catch(() => null);
    }),
    getJSONOr<StockRpsResp | null>(`/api/stock/rps?code=${selectedCode}`, null),
    getJSONOr<BreadthResp | null>('/api/market/breadth?days=1', null),
  ]);

  if (!quote) throw new Error('获取行情失败');

  // 市场状态判定（仓位联动）：breadth 最新日涨跌比 + 站上55日线比例
  const breadthLatest = breadthRes?.items?.[0];
  let marketRegime: MarketRegime = 'neutral';
  if (breadthLatest) {
    const ad = (breadthLatest.advance || 0) + (breadthLatest.decline || 0);
    const adRatio = ad > 0 ? (breadthLatest.advance || 0) / ad : 0.5;
    const aboveRatio = typeof breadthLatest.aboveMa55Ratio === 'number' ? breadthLatest.aboveMa55Ratio : 0.5;
    const score = adRatio * 0.5 + aboveRatio * 0.5;
    marketRegime = score >= 0.6 ? 'strong' : score <= 0.4 ? 'weak' : 'neutral';
  }

  const tushareIssues = [...(tushareData?.errors || []), ...(tushareData?.warnings || [])];
  const tushareBlock = formatTushareForPrompt(tushareData);

  const updatedKLines = kLines.length >= 5 ? buildUpdatedKLines(quote, kLines) : kLines;
  const chip: ChipDistribution | null = await getChipData(selectedCode).catch(() => null);
  const engineResults = checkAllRules(updatedKLines, quote, ALERT_RULES.filter(r => r.isEnabled), chip);
  const engineSummary = engineResults.length > 0
    ? engineResults.map(r => `${r.ruleId}:${r.message}`).join('; ')
    : '未触发任何破位/死叉/急跌等风险信号，技术面健康';

  const chipNote = chip
    ? `[筹码分布]\n主峰价位: ${chip.dominantPeak} | 平均成本: ${chip.avgCost} | 获利盘: ${(chip.profitRatio * 100).toFixed(1)}% | 90%集中度: ${chip.concentration90.toFixed(3)}（越小越密集） | 峰位相对位置: ${chip.peakPos.toFixed(3)}（站上主峰为正） | 5日峰位漂移: ${chip.peakDrift.toFixed(3)}（下移为吸筹）\n（筹码形态仅供参考，需结合趋势与量能综合判断）\n\n`
    : '';

  const quoteJson = JSON.stringify(quote, null, 2);
  const klineSummary = kLines.slice(-60).map(k => `${k.date} ${k.open} ${k.high} ${k.low} ${k.close} ${k.volume}`).join('\n');
  const klineSummary20 = kLines.slice(-20).map(k => `${k.date} ${k.open} ${k.high} ${k.low} ${k.close} ${k.volume}`).join('\n');

  const indicatorResult = calculateIndicators(updatedKLines);
  const indicatorBlock = formatIndicatorsForPrompt(indicatorResult);

  const tradeLevels = computeKeyLevels({
    kLines: updatedKLines,
    indicators: indicatorResult,
    chip,
    engineResults,
    quote,
    rps250: rpsRes && !rpsRes.error ? (rpsRes.rps250 ?? null) : null,
    positionPercent: stock.positionPercent,
    marketRegime,
  });
  const levelsText = formatLevelsForPrompt(tradeLevels);

  const reflectionBlock = buildReflectionContext(selectedCode, history, { price: quote.price, changePercent: quote.changePercent });

  const positionNote = stock.positionPercent !== undefined
    ? `注意：该股票占用户总持仓的${stock.positionPercent}%，请在分析中考虑仓位集中度风险。`
    : undefined;
  const positionNoteVerdict = stock.positionPercent !== undefined
    ? `用户当前持仓占比为${stock.positionPercent}%，请在仓位建议中考虑现有持仓，如需减持请明确说明。`
    : undefined;

  const marketStatusNote = `[市场状态] ${await fetchMarketStatusNote()}\n\n`;
  const rpsNote = rpsRes && !rpsRes.error
    ? `[RPS强度] 20日:${rpsRes.rps20?.toFixed(1)} 60日:${rpsRes.rps60?.toFixed(1)} 120日:${rpsRes.rps120?.toFixed(1)} 250日:${rpsRes.rps250?.toFixed(1)}（${(rpsRes.rps250 ?? 0) >= 95 ? '全市场前5%极强' : (rpsRes.rps250 ?? 0) >= 87 ? '强势' : '中等偏弱'}）\n\n`
    : '';
  const etf = isETF(selectedCode);
  let etfHoldingsNote = '';
  if (etf) {
    const em = selectedCode.match(/^([a-z]+)(\d+)$/i);
    if (em) {
      const thscode = `${em[2]}.${em[1].toUpperCase()}`;
      const fundRes = await getJSONOr<FuyaoFundResp | null>(`/api/fuyao/fund?code=${thscode}`, null);
      if (fundRes?.holdings && fundRes.holdings.length > 0) {
        etfHoldingsNote = `[基金持仓] 前${fundRes.holdings.length}大重仓股：${fundRes.holdings.map((h: any) => `${h.stock_name}(${h.hold_ratio.toFixed(1)}%)`).join('、')}\n\n`;
      }
    }
  }

  const stage1 = {
    systemPrompt: buildAnalystSystemPrompt(etf),
    userPrompt: marketStatusNote + rpsNote + etfHoldingsNote + chipNote + buildAnalystUserPrompt(selectedCode, stock.name, quoteJson, klineSummary, engineSummary, indicatorBlock, reflectionBlock, positionNote, etf, tushareBlock, getIndustry(selectedCode)),
  };
  const stage2 = {
    systemPrompt: '',
    userPrompt: buildDebateDataPrompt(selectedCode, stock.name, quoteJson, indicatorBlock, marketStatusNote, engineSummary, klineSummary20, chipNote),
  };
  const compactQuote = `当前价 ${quote.price} 元，涨跌 ${quote.changePercent.toFixed(2)}%（昨收 ${quote.preClose}，开盘 ${quote.open}，最高 ${quote.high}，最低 ${quote.low}）`;
  const stage3 = {
    systemPrompt: buildVerdictSystemPrompt(),
    userPrompt: buildVerdictUserPrompt(selectedCode, stock.name, '', '', compactQuote, positionNoteVerdict, engineSummary, levelsText),
  };

  const entryDate = breadthLatest?.date || (rpsRes as any)?.calcDate || new Date().toISOString().slice(0, 10).replace(/-/g, '');

  return { stockCode: selectedCode, stage1, stage2, stage3, tradeLevels, marketRegime, tushareIssues, entryDate, quote };
}

// ── 深度分析执行：浏览器直连（主路径）+ 服务器中转（降级）──────────────
export interface RunDeepOptions {
  ctx: DeepContext;
  cfg: LlmConfig;
  resumeCompleted?: Record<string, string>;
  userView?: string;
  userViewReason?: string;
  signal: AbortSignal;
  onProgress: (p: DeepProgress) => void;
}

export interface RunDeepOutcome {
  result: DeepResult;
  completedMap: Record<string, string>;
}

/** Jaccard 相似度（bigram 分词）— 辩论轮间卡死检测（与服务器版同） */
function jaccardSimilarity(a: string, b: string): number {
  const bigrams = (s: string) => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const sa = bigrams(a);
  const sb = bigrams(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let intersection = 0;
  for (const gram of sa) if (sb.has(gram)) intersection++;
  return intersection / (sa.size + sb.size - intersection);
}

/** 裁决历史校准注记：从 /api/ai/calibration 拉（数据在服务器 DB，失败返回空串不阻断） */
async function fetchCalibrationNote(stockCode: string): Promise<string> {
  try {
    const res = await getJSON<{ note?: string }>(`/api/ai/calibration?stockCode=${encodeURIComponent(stockCode)}`);
    return res.note || '';
  } catch {
    return '';
  }
}

/**
 * 浏览器直连编排 — 镜像服务器 /api/ai/deep-analyze 的三阶段逻辑：
 * 情报收集 → 三人两轮辩论 → 最终裁决，9 次串行 LLM 调用全部从浏览器直发。
 * - 阶段内重试/卡死检测/超时 fail-fast 与服务器版一致
 * - 连接层失败（CORS/TypeError）原样冒泡，由 runDeepAnalysisStream 降级到服务器中转
 * - completedMap 实时写外部传入的 ref，降级时可断点续传
 */
async function runDeepAnalysisDirect(opts: RunDeepOptions, completedMap: Record<string, string>): Promise<RunDeepOutcome> {
  const { ctx, cfg, userView, userViewReason, signal, onProgress } = opts;
  console.info(`[Deep AI Direct] 直连分析开始 model=${cfg.model} baseUrl=${cfg.baseUrl}`);

  let analystText = '', analystReasoning = '';
  let debateText = '', debateReasoning = '', debateError = '';
  let verdictText = '', verdictReasoning = '', verdictError = '';
  let stage: DeepStage = 'idle';

  const emit = (structured?: DeepStructured | null) => {
    onProgress({
      stage,
      result: {
        analyst: analystText,
        analystReasoning: analystReasoning || undefined,
        debate: debateText,
        debateReasoning: debateReasoning || undefined,
        debateError: debateError || undefined,
        verdict: verdictText,
        verdictReasoning: verdictReasoning || undefined,
        verdictError: verdictError || undefined,
        levels: { current: ctx.tradeLevels.currentPrice, supports: ctx.tradeLevels.supports, resistances: ctx.tradeLevels.resistances },
        structured: structured ?? null,
      },
    });
  };

  /** 单阶段 LLM 调用。重试策略镜像服务器 runStage；连接层错误冒泡供降级判定 */
  const runStage = async (stageKey: string, systemPrompt: string, userPrompt: string, maxTokens = 4096, attempt = 1): Promise<{ text: string; reasoning: string }> => {
    let fullOutput = '', fullReasoning = '';
    let lastDelta = '', repeatCount = 0;
    let stuckWarning = false;
    try {
      await streamChatDirect({
        baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        temperature: 0.3, maxTokens,
        signal, timeoutMs: 120000,
        onDelta: (d) => {
          if (d.reasoning) {
            fullReasoning += d.reasoning;
            // analyst/verdict 的 reasoning 直播给前端；辩论角色不直播（与服务器版一致，补发时统一带）
            if (stageKey === 'analyst') { analystReasoning += d.reasoning; emit(); }
            else if (stageKey === 'verdict') { verdictReasoning += d.reasoning; emit(); }
          }
          if (d.content) {
            if (d.content === lastDelta) repeatCount++;
            else { repeatCount = 0; lastDelta = d.content; }
            if (repeatCount >= 3 && !stuckWarning) {
              stuckWarning = true;
              console.warn(`[Deep AI Direct] ${stageKey} 检测到卡死（连续重复输出）`);
            }
            fullOutput += d.content;
          }
        },
      });
    } catch (e: any) {
      if (e.name === 'AbortError') throw e; // 用户取消，原样冒泡
      const isTimeout = /超时|timeout/i.test(e.message || '');
      if (isTimeout) throw new Error(`[${stageKey}] 阶段超时（120s），模型未在限定时间内响应`);
      const isRetryableNetwork = e.name === 'TypeError' || /fetch|network/i.test(e.message || '');
      if (attempt < 2 && isRetryableNetwork) {
        const backoff = 2000 * attempt;
        console.warn(`[Deep AI Direct] ${stageKey} 网络错误，${backoff}ms 后重试 ${attempt}/2`);
        await new Promise(r => setTimeout(r, backoff));
        return runStage(stageKey, systemPrompt, userPrompt, maxTokens, attempt + 1);
      }
      if (e instanceof LlmHttpError && attempt < 2 && (e.status === 429 || e.status >= 500)) {
        const backoff = 2000 * attempt;
        console.warn(`[Deep AI Direct] ${stageKey} HTTP ${e.status}，${backoff}ms 后重试 ${attempt}/2`);
        await new Promise(r => setTimeout(r, backoff));
        return runStage(stageKey, systemPrompt, userPrompt, maxTokens, attempt + 1);
      }
      throw e.message?.startsWith(`[${stageKey}]`)
        ? e
        : new Error(`[${stageKey}] ${e.message || '未知错误'}`);
    }

    if (!fullOutput.trim()) {
      console.warn(`[Deep AI Direct] ${stageKey} 输出为空（流式响应无 content 增量），重试 ${attempt}/2`);
      if (attempt < 2) {
        return runStage(stageKey, systemPrompt, userPrompt, maxTokens, attempt + 1);
      }
      throw new Error(`[${stageKey}] 输出为空`);
    }
    return { text: fullOutput, reasoning: fullReasoning };
  };

  /** 断点续传：completedMap 命中回放，否则 runStage 直播并写回 */
  const runOrReplay = async (stageKey: string, sys: string, usr: string, maxTokens: number, isDebate = false): Promise<string> => {
    const cached = completedMap[stageKey];
    if (cached != null) {
      if (isDebate) {
        debateText += cached + '\n\n';
        stage = 'debate';
        emit();
      } else if (stageKey === 'analyst') {
        analystText += cached;
        stage = 'analyst';
        emit();
      } else if (stageKey === 'verdict') {
        verdictText += cached;
        stage = 'verdict';
        emit(parseVerdictContent(verdictText, ctx.tradeLevels));
      }
      return cached;
    }
    const { text, reasoning } = await runStage(stageKey, sys, usr, maxTokens);
    if (isDebate) {
      debateText += text + '\n\n';
      stage = 'debate';
      if (reasoning) debateReasoning = (debateReasoning ? debateReasoning + '\n\n' : '') + reasoning;
      emit();
    } else if (stageKey === 'analyst') {
      analystText += text;
      stage = 'analyst';
      emit();
    }
    completedMap[stageKey] = text;
    saveDeepResume(ctx.stockCode, completedMap);
    return text;
  };

  // ===== 阶段一：情报收集 =====
  const stage1Output = await runOrReplay('analyst', ctx.stage1.systemPrompt, ctx.stage1.userPrompt, 4096);

  // ===== 阶段二：多空辩论（任一角色失败即终止整次分析）=====
  let stage2Output = '';
  // 辩论基础数据 prompt（不含分析师报告，角色不需要读完整报告）
  const userViewNote = userView ? `\n\n[用户观点] 用户当前${userView}。理由：${userViewReason || '未说明'}。\n各角色在论证时可参考用户观点，但不要迎合——用数据验证或反驳用户的看法。` : '';
  const debateData = [
    ctx.stage2.userPrompt.split('以下是一份深度分析师报告')[0]?.trim() || '',
    userViewNote,
  ].filter(Boolean).join('\n\n');

  // Round 1: 三人串行
  const t1 = await runOrReplay('tech', buildTechR1SystemPrompt(), debateData, 2048, true);
  const r1 = await runOrReplay('risk', buildRiskR1SystemPrompt(), debateData, 2048, true);
  const x1 = await runOrReplay('xinjie', buildXinJieR1DebatePrompt(), debateData, 2048, true);
  stage2Output += [t1, r1, x1].join('\n\n');

  // Round 2: 串行反驳（累计上下文）
  debateText += '\n--- 第二轮 ---\n';
  stage = 'debate';
  emit();

  const techR2Ctx = `前面两人的第一轮发言：\n${r1}\n${x1}\n\n请回应以上两人的观点。`;
  const techR2 = await runOrReplay('tech_r2', buildTechR2RebuttalPrompt(), techR2Ctx, 2048, true);

  const riskR2Ctx = `第一轮发言回顾：\n${t1}\n${x1}\n\n技术分析师的回应：\n${techR2}\n\n请回应以上内容。`;
  const riskR2 = await runOrReplay('risk_r2', buildRiskR2RebuttalPrompt(), riskR2Ctx, 2048, true);

  const xinjieR2Ctx = `第一轮：\n${t1}\n${r1}\n\n第二轮回应：\n技术分析师："${techR2.slice(0, 200)}"\n风控专家："${riskR2.slice(0, 200)}"\n\n请给出你的最终判断。`;
  const xinjieR2 = await runOrReplay('xinjie_r2', buildXinJieR2RebuttalPrompt(), xinjieR2Ctx, 2048, true);

  const mgrCtx = `第一轮发言：\n技术分析师：${t1.slice(0, 200)}\n风控专家：${r1.slice(0, 200)}\n心姐：${x1.slice(0, 200)}\n\n第二轮反驳：\n技术反驳：${techR2.slice(0, 200)}\n风控反驳：${riskR2.slice(0, 200)}\n心姐最终判断：${xinjieR2.slice(0, 200)}`;
  const mgrOutput = await runOrReplay('manager', buildManagerPrompt(), mgrCtx, 2048, true);

  stage2Output += '\n--- R2 ---\n' + [techR2, riskR2, xinjieR2, mgrOutput].join('\n\n');

  // 卡死检测：R1 vs R2 相似度（与服务器版一致，仅记日志）
  const r1All = t1 + r1 + x1;
  const similarity = jaccardSimilarity(r1All, techR2 + riskR2 + xinjieR2);
  if (similarity >= 0.7) {
    console.warn(`[Deep AI Direct] 辩论轮间相似度过高 (${(similarity * 100).toFixed(0)}%)`);
  }

  // ===== 阶段三：最终裁决 =====
  const s3System = ctx.stage3.systemPrompt || buildVerdictSystemPrompt();
  const userViewVerdict = userView ? `\n\n[用户观点] 用户当前${userView}，理由：${userViewReason || '未说明'}。请在决策理由中评价用户观点是否成立（用数据说话，不要迎合用户）。` : '';
  // P2：历史校准注入（真实回测胜率，拼在 ## 分析师报告 前；样本不足/失败返回空串）
  const calibrationNote = await fetchCalibrationNote(ctx.stockCode);
  const s3User = [
    ctx.stage3.userPrompt.split('## 分析师报告')[0]?.trim() || '',
    calibrationNote,
    `## 分析师报告\n${stage1Output}`,
    `## 多空辩论\n${stage2Output}`,
    userViewVerdict,
    '请基于以上信息，做出最终投资决策。**注意：目标价和止损价必须参考实时行情中的当前价格。**',
  ].filter(Boolean).join('\n\n');
  await runOrReplay('verdict', s3System, s3User, 4096);

  const finalStructured = parseVerdictContent(verdictText, ctx.tradeLevels);
  return {
    result: {
      analyst: analystText,
      analystReasoning: analystReasoning || undefined,
      debate: debateText,
      debateReasoning: debateReasoning || undefined,
      debateError: debateError || undefined,
      verdict: verdictText,
      verdictReasoning: verdictReasoning || undefined,
      verdictError: verdictError || undefined,
      levels: { current: ctx.tradeLevels.currentPrice, supports: ctx.tradeLevels.supports, resistances: ctx.tradeLevels.resistances },
      structured: finalStructured,
    },
    completedMap,
  };
}

/**
 * 深度分析入口：优先浏览器直连（省服务器出站流量 + 少一跳香港）。
 * 直连不可达（CORS / TypeError / 超时 / 空输出）→ 降级服务器中转，已完成阶段断点续传重跑。
 * 空输出也算降级：浏览器环境可能吞流（代理/中间件），服务器侧通常正常。
 */
// ── 直连熔断：连续失败降级并冷却，防止重试风暴烧 token / 触发限流 ──────
const DIRECT_CIRCUIT_KEY = 'ai-direct-circuit';
const CIRCUIT_MAX_FAILURES = 3;
const CIRCUIT_TTL_MS = 24 * 3600 * 1000;

function readCircuit(): { count: number; at: number } {
  try {
    const raw = localStorage.getItem(DIRECT_CIRCUIT_KEY);
    if (!raw) return { count: 0, at: 0 };
    const parsed = JSON.parse(raw);
    return { count: Number(parsed.count) || 0, at: Number(parsed.at) || 0 };
  } catch {
    return { count: 0, at: 0 };
  }
}

function isDirectCircuited(): boolean {
  const c = readCircuit();
  return c.count >= CIRCUIT_MAX_FAILURES && Date.now() - c.at < CIRCUIT_TTL_MS;
}

function recordDirectFailure(): void {
  try {
    const c = readCircuit();
    localStorage.setItem(DIRECT_CIRCUIT_KEY, JSON.stringify({ count: c.count + 1, at: Date.now() }));
  } catch { /* 隐私模式等忽略 */ }
}

function resetDirectCircuit(): void {
  try {
    localStorage.setItem(DIRECT_CIRCUIT_KEY, JSON.stringify({ count: 0, at: 0 }));
  } catch { /* 忽略 */ }
}

// ── 断点持久化：每完成一个阶段写 localStorage，中断/刷新/锁屏后可恢复续跑 ──
const RESUME_KEY = 'deep-analysis-resume';
const RESUME_TTL_MS = 7 * 24 * 3600 * 1000; // 断点 7 天后过期

export interface DeepResume {
  stockCode: string;
  completed: Record<string, string>;
  savedAt: number;
}

export function loadDeepResume(): DeepResume | null {
  try {
    const raw = localStorage.getItem(RESUME_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DeepResume;
    if (!parsed.completed || typeof parsed.stockCode !== 'string' || Object.keys(parsed.completed).length === 0) return null;
    if (Date.now() - (parsed.savedAt || 0) > RESUME_TTL_MS) {
      localStorage.removeItem(RESUME_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearDeepResume(): void {
  try { localStorage.removeItem(RESUME_KEY); } catch { /* 忽略 */ }
}

/** 保存断点（同标的合并：保留旧键，新阶段覆盖） */
function saveDeepResume(stockCode: string, completed: Record<string, string>): void {
  try {
    const prev = loadDeepResume();
    const merged = {
      ...(prev && prev.stockCode === stockCode ? prev.completed : {}),
      ...completed,
    };
    localStorage.setItem(RESUME_KEY, JSON.stringify({ stockCode, completed: merged, savedAt: Date.now() }));
  } catch { /* localStorage 满/隐私模式忽略 */ }
}

/**
 * 深度分析入口：优先浏览器直连（省服务器出站流量 + 少一跳香港）。
 * - 直连不可达（CORS / TypeError / 超时 / 空输出）→ 计数并降级服务器中转，已完成阶段断点续传
 * - 连续失败熔断：24h 内不再尝试直连，直接走服务器（手机移动网络等环境直连不稳时自动让位）
 * - 直连成功自动清零熔断计数
 * - 断点持久化：每完成一个阶段写 localStorage，任何失败/中断后刷新页面仍可"继续生成"续跑
 */
export async function runDeepAnalysisStream(opts: RunDeepOptions): Promise<RunDeepOutcome> {
  if (isDirectCircuited()) {
    console.warn('[Deep AI Direct] 熔断冷却中（连续失败过多），直接走服务器中转');
    return runDeepAnalysisViaServer(opts);
  }
  const completedRef: Record<string, string> = { ...(opts.resumeCompleted || {}) };
  try {
    const outcome = await runDeepAnalysisDirect(opts, completedRef);
    resetDirectCircuit();
    clearDeepResume(); // 完整分析成功，断点作废
    return outcome;
  } catch (e: any) {
    if (e.name === 'AbortError') throw e; // 用户主动取消，不存断点
    if (isDirectConnectionError(e) || /输出为空|阶段超时/.test(e.message || '')) {
      recordDirectFailure();
      console.warn('[Deep AI Direct] 直连异常，降级服务器中转:', e.message);
      try {
        const outcome = await runDeepAnalysisViaServer({ ...opts, resumeCompleted: completedRef });
        clearDeepResume(); // 完整分析成功，断点作废
        return outcome;
      } catch (e2: any) {
        if (e2.name !== 'AbortError') saveDeepResume(opts.ctx.stockCode, completedRef);
        throw e2;
      }
    }
    saveDeepResume(opts.ctx.stockCode, completedRef);
    throw e;
  }
}

/** 降级路径：服务器中转 SSE（原实现保留，作兜底） */
async function runDeepAnalysisViaServer(opts: RunDeepOptions): Promise<RunDeepOutcome> {
  const { ctx, cfg, resumeCompleted, userView, userViewReason, signal, onProgress } = opts;

  const res = await fetch('/api/ai/deep-analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      stockCode: ctx.stockCode,
      stage1: ctx.stage1, stage2: ctx.stage2, stage3: ctx.stage3,
      baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model,
      completed: resumeCompleted,
      userView: userView || undefined,
      userViewReason: userViewReason || undefined,
    }),
    signal,
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(errData.error || 'API请求失败');
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  let analystText = '', analystReasoning = '';
  let debateText = '', debateReasoning = '', debateError = '';
  let verdictText = '', verdictReasoning = '', verdictError = '';
  const completedMap: Record<string, string> = {};
  let stage: DeepStage = 'idle';

  const emit = (structured?: DeepStructured | null) => {
    onProgress({
      stage,
      result: {
        analyst: analystText,
        analystReasoning: analystReasoning || undefined,
        debate: debateText,
        debateReasoning: debateReasoning || undefined,
        debateError: debateError || undefined,
        verdict: verdictText,
        verdictReasoning: verdictReasoning || undefined,
        verdictError: verdictError || undefined,
        levels: { current: ctx.tradeLevels.currentPrice, supports: ctx.tradeLevels.supports, resistances: ctx.tradeLevels.resistances },
        structured: structured ?? null,
      },
    });
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    sseBuffer += decoder.decode(value, { stream: true });
    const lines = sseBuffer.split('\n');
    sseBuffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') continue;

      try {
        const msg = JSON.parse(data);
        if (msg.error && !msg.stage) throw new Error(msg.error);

        if (msg.stage === 'analyst') {
          if (msg.text !== undefined) { analystText += msg.text; stage = 'analyst'; emit(); }
          if (msg.reasoning) { analystReasoning += msg.reasoning; emit(); }
          if (msg.done) completedMap.analyst = analystText;
        }
        if (msg.stage === 'debate') {
          if (msg.role && msg.text !== undefined) completedMap[msg.role] = msg.text.replace(/\n+$/, '');
          if (msg.text !== undefined) { debateText += msg.text; stage = 'debate'; emit(); }
          if (msg.reasoning) { debateReasoning += msg.reasoning; emit(); }
          if (msg.error) { debateError = msg.error; emit(); }
        }
        if (msg.stage === 'verdict') {
          if (msg.text !== undefined) {
            verdictText += msg.text;
            stage = 'verdict';
            emit(parseVerdictContent(verdictText, ctx.tradeLevels));
          }
          if (msg.reasoning) { verdictReasoning += msg.reasoning; emit(); }
          if (msg.done) completedMap.verdict = verdictText;
          if (msg.error) { verdictError = msg.error; emit(); }
        }
      } catch (e: any) {
        if (e.message && !e.message.includes('JSON')) {
          // 服务器路径中途失败：保存断点（含直连回放 + 服务器新完成阶段），刷新后可续跑
          saveDeepResume(ctx.stockCode, completedMap);
          throw e;
        }
      }
    }
  }

  const finalStructured = parseVerdictContent(verdictText, ctx.tradeLevels);
  return {
    result: {
      analyst: analystText,
      analystReasoning: analystReasoning || undefined,
      debate: debateText,
      debateReasoning: debateReasoning || undefined,
      debateError: debateError || undefined,
      verdict: verdictText,
      verdictReasoning: verdictReasoning || undefined,
      verdictError: verdictError || undefined,
      levels: { current: ctx.tradeLevels.currentPrice, supports: ctx.tradeLevels.supports, resistances: ctx.tradeLevels.resistances },
      structured: finalStructured,
    },
    completedMap,
  };
}

// ── 历史摘要组装 + 全局回测落库 ─────────────────────────────────────
export function buildDeepSummary(result: DeepResult): string {
  let debateConclusion = '';
  const debateMatch = result.debate.match(/【综合评判】([\s\S]*?)(?=\n【|\n###|\n$|$)/);
  if (debateMatch) debateConclusion = debateMatch[1].trim();

  const parts: string[] = [];
  if (debateConclusion) parts.push(`📊 综合评判：${debateConclusion}`);
  if (result.structured?.action) {
    parts.push(`⚖️ 最终决策：${result.structured.action} | 风险${result.structured.riskLevel} | 信心${result.structured.confidence}%`);
  }
  if (result.structured?.reasoning) parts.push(`📝 ${result.structured.reasoning}`);
  return parts.join('\n\n') || result.analyst.slice(0, 500).trim();
}

export function buildDeepSuggestion(structured: DeepStructured | null): string {
  if (!structured?.action) return '见详细报告';
  return `仓位:${Number.isFinite(structured.position) ? structured.position.toFixed(0) : '--'}% | 目标:${Number.isFinite(structured.targetLow) ? structured.targetLow.toFixed(2) : '--'}-${Number.isFinite(structured.targetHigh) ? structured.targetHigh.toFixed(2) : '--'} | 止损:${Number.isFinite(structured.stopLoss) ? structured.stopLoss.toFixed(2) : '--'}`;
}

/** 全局回测落库（匿名，按 股票+交易日+建议 去重；失败静默） */
export async function saveDeepEval(params: {
  stockCode: string; stockName: string; entryDate: string; entryPrice: number;
  structured: DeepStructured | null;
  marketRegime?: MarketRegime;
}): Promise<void> {
  const { structured } = params;
  try {
    await postJSON('/api/ai/deep-eval', {
      stockCode: params.stockCode, stockName: params.stockName,
      entryDate: params.entryDate, entryPrice: params.entryPrice,
      action: structured?.action,
      targetLow: structured && Number.isFinite(structured.targetLow) ? structured.targetLow : null,
      targetHigh: structured && Number.isFinite(structured.targetHigh) ? structured.targetHigh : null,
      stopLoss: structured && Number.isFinite(structured.stopLoss) ? structured.stopLoss : null,
      position: structured && Number.isFinite(structured.position) ? structured.position : null,
      confidence: structured?.confidence,
      reasoning: structured?.reasoning,
      marketRegime: params.marketRegime ?? null,
    });
  } catch {
    // 回测落库失败不阻断分析
  }
}
