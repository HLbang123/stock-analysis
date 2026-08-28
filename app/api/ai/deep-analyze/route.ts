import { NextRequest, NextResponse } from 'next/server';
import { formatAiError, formatNetworkError, FatalApiError, isFatalApiStatus } from '@/lib/ai-error';
import { buildChatUrl, buildLLMHeaders, createTimeoutSignal, llmRouteError, sseResponse } from '@/lib/llm-client';
import { readLlmDeltas, encodeSSE, endSSE } from '@/lib/llm-stream';
import {
  buildTechR1SystemPrompt, buildRiskR1SystemPrompt,
  buildXinJieR1DebatePrompt, buildXinJieR2RebuttalPrompt,
  buildTechR2RebuttalPrompt, buildRiskR2RebuttalPrompt,
  buildVerdictSystemPrompt,
} from '@/services/deepAnalysisPrompt';
import { buildCalibrationNote } from '@/services/deep-analysis/calibration';

// Jaccard 相似度（bigram 分词）— 检测辩论轮间的卡死
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

const STUCK_THRESHOLD = 0.7;

/**
 * 深度分析代理 — 三阶段 SSE 流式编排
 * 阶段一：情报收集 → 阶段二：多空辩论 → 阶段三：最终裁决
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { stockCode, isETF, stage1, stage2, stage3, baseUrl, apiKey, model, completed, userView, userViewReason } = body;

    if (!baseUrl || !model) {
      return NextResponse.json(
        { error: '缺少必要参数: baseUrl, model' },
        { status: 400 }
      );
    }

    if (!stage1?.systemPrompt || !stage1?.userPrompt) {
      return NextResponse.json(
        { error: '缺少阶段一参数' },
        { status: 400 }
      );
    }

    const url = buildChatUrl(baseUrl);
    const llmHeaders = buildLLMHeaders(apiKey);

    console.log(`[Deep AI Proxy] Starting 3-stage analysis with model ${model}`);

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        // 心跳：SSE 注释行（: 开头），客户端自动忽略，CF 视作数据流动重置空闲计时。
        // 覆盖每个阶段 fetch 发出到首 token 之间的空隙，以及阶段切换间隙。
        const heartbeat = setInterval(() => {
          try { controller.enqueue(encoder.encode(': keepalive\n\n')); } catch { /* 流已关闭 */ }
        }, 15000);

        /** 执行一个阶段的 LLM 调用，流式输出到客户端，返回完整输出文本 + 思考过程。任何失败最终都抛出（带 [stage] 前缀） */
        async function runStage(stageKey: string, systemPrompt: string, userPrompt: string, maxTokens = 4096, attempt = 1): Promise<{ text: string; reasoning: string }> {
          let fullOutput = '';
          let fullReasoning = '';
          // 240s：思考型模型 + 12288 预算下复杂裁决可思考 8-10k token（约 100-200s），120s 必然撞线（ranker 以 300s 配 12288）
          const { signal, clear } = createTimeoutSignal(240000);

          try {
            const llmResponse = await fetch(url, {
              method: 'POST',
              headers: llmHeaders,
              body: JSON.stringify({
                model,
                messages: [
                  { role: 'system', content: systemPrompt },
                  { role: 'user', content: userPrompt },
                ],
                temperature: 0.3,
                max_tokens: maxTokens,
                stream: true,
              }),
              signal,
            });

            // 注意：此处不再 clear() —— 定时器需存活到流式读取结束，全程超时才算数
            if (!llmResponse.ok) {
              const errorText = await llmResponse.text().catch(() => '');
              console.error(`[Deep AI Proxy] ${stageKey} HTTP ${llmResponse.status}: ${errorText}`);
              // 限流 / 服务端错误：退避重试
              if (attempt < 3 && (llmResponse.status === 429 || llmResponse.status >= 500)) {
                clear();
                const backoff = 2000 * attempt;
                console.warn(`[Deep AI Proxy] ${stageKey} HTTP ${llmResponse.status}，${backoff}ms 后重试 ${attempt}/2`);
                await new Promise(r => setTimeout(r, backoff));
                return runStage(stageKey, systemPrompt, userPrompt, maxTokens, attempt + 1);
              }
              // max_tokens 400 兜底（镜像 ranker）：厂商/中转把 max_tokens 卡得更小时报 400，降档 4096 重试避免整档失败
              if (attempt < 3 && llmResponse.status === 400
                && /max[_ -]?tokens?|max completion/i.test(errorText) && maxTokens > 4096) {
                clear();
                const backoff = 2000 * attempt;
                console.warn(`[Deep AI Proxy] ${stageKey} max_tokens 超上限 400，${backoff}ms 后降档 4096 重试 ${attempt}/2`);
                await new Promise(r => setTimeout(r, backoff));
                return runStage(stageKey, systemPrompt, userPrompt, 4096, attempt + 1);
              }
              // 致命 API 配置错误（401/403/404/402）：重试无意义，直接 fail-hard
              if (isFatalApiStatus(llmResponse.status)) {
                throw new FatalApiError(formatAiError(llmResponse.status, errorText));
              }
              throw new Error(`[${stageKey}] ${formatAiError(llmResponse.status, errorText)}`);
            }

            let lastDelta = '';
            let repeatCount = 0;
            let stuckWarning = false;
            let finishReason = '';

            await readLlmDeltas(llmResponse, (d) => {
              // reasoning 累积（不进 fullOutput，避免污染下游辩论/裁决 prompt），单独通道发给前端折叠展示
              if (d.reasoning) {
                fullReasoning += d.reasoning;
                encodeSSE(encoder, controller, { stage: stageKey, reasoning: d.reasoning });
              }
              if (d.content) {
                // 卡死检测：连续相同输出（只看正文，不看 reasoning）
                if (d.content === lastDelta) {
                  repeatCount++;
                } else {
                  repeatCount = 0;
                  lastDelta = d.content;
                }
                if (repeatCount >= 3 && !stuckWarning) {
                  stuckWarning = true;
                  console.warn(`[Deep AI Proxy] ${stageKey} 检测到卡死（连续重复输出）`);
                  encodeSSE(encoder, controller, { stage: stageKey, warning: '检测到输出重复，可能陷入循环' });
                }

                fullOutput += d.content;
                encodeSSE(encoder, controller, { stage: stageKey, text: d.content });
              }
            }, (r) => { finishReason = r; });

            // 空输出：模型异常，重试；仍空则抛出
            if (!fullOutput.trim()) {
              if (attempt < 3) {
                console.warn(`[Deep AI Proxy] ${stageKey} 输出为空，重试 ${attempt}/2`);
                return runStage(stageKey, systemPrompt, userPrompt, maxTokens, attempt + 1);
              }
              throw new Error(`[${stageKey}] 输出为空`);
            }
            // finish_reason='length'：思考型模型思考烧光预算、正文被截断。同样输入重试会同样截断，
            // 直接抛给外层降级链（裁决三档递减/规则兜底），而不是把残次输出静默当成功
            if (finishReason === 'length') {
              throw new Error(`[${stageKey}] 输出被截断（达到 token 上限 ${maxTokens}）`);
            }
          } catch (e: any) {
            clear();
            // 超时：Node fetch 的 abort 会包成 TypeError("fetch failed")，真实原因在 cause
            const isAbort = e.name === 'AbortError'
              || e.cause?.name === 'AbortError'
              || e.cause?.code === 'ABORT_ERR'
              || /abort/i.test(e.message || '');
            if (isAbort) {
              // 超时重试无意义（模型卡住/端点 stalled），直接 fail-fast
              throw new Error(`[${stageKey}] 阶段超时（240s），模型未在限定时间内响应`);
            }
            if (attempt < 3 && (e.message?.includes('fetch failed') || e.name === 'TypeError')) {
              const backoff = 2000 * attempt;
              console.warn(`[Deep AI Proxy] ${stageKey} 网络错误，${backoff}ms 后重试 ${attempt}/2`);
              await new Promise(r => setTimeout(r, backoff));
              return runStage(stageKey, systemPrompt, userPrompt, maxTokens, attempt + 1);
            }
            // 致命 API 配置错误（401/402/403/404）已由 formatAiError 翻译好，原样冒泡，别套"网络连接失败"误导
            if (e instanceof FatalApiError) throw e;
            // 已带 [stageKey] 前缀的错误直接抛，否则用 formatNetworkError 翻译网络原因
            throw e.message?.startsWith(`[${stageKey}]`)
              ? e
              : new Error(`[${stageKey}] ${formatNetworkError(e)}`);
          }

          clear(); // 成功：流式已读完，释放超时定时器
          encodeSSE(encoder, controller, { stage: stageKey, done: true, full: fullOutput });
          return { text: fullOutput, reasoning: fullReasoning };
        }

        /** 断点续传：命中缓存（completed[stageKey]）则回放文本跳过 LLM 调用，否则正常执行 runStage */
        async function runOrReplay(stageKey: string, sys: string, usr: string, maxTokens: number, isDebate = false): Promise<string> {
          const cached = completed?.[stageKey];
          if (cached != null) {
            if (isDebate) {
              encodeSSE(encoder, controller, { stage: 'debate', role: stageKey, text: cached + '\n\n' });
            } else {
              // full 权威全量回放（客户端覆盖而非追加，重复执行也幂等）
              encodeSSE(encoder, controller, { stage: stageKey, full: cached, done: true });
            }
            console.log(`[Deep AI Proxy] ${stageKey} 命中缓存，跳过 LLM 调用`);
            return cached;
          }
          const { text, reasoning } = await runStage(stageKey, sys, usr, maxTokens);
          if (isDebate) {
            // 辩论阶段：runStage 的 live 流（stage=角色名）客户端按角色缓冲拼装，
            // 这里以 stage='debate' 补发权威全量 + 思考过程（覆盖增量，防重试/丢包不一致）
            encodeSSE(encoder, controller, {
              stage: 'debate', role: stageKey,
              text: text + '\n\n',
              ...(reasoning ? { reasoning } : {}),
            });
          }
          return text;
        }

        try {
          // 波1 前置：辩论基础数据（不含分析师报告）
          const userViewNote = userView ? `\n\n[用户观点] 用户当前${userView}。理由：${userViewReason || '未说明'}。\n各角色在论证时可参考用户观点，但不要迎合——用数据验证或反驳用户的看法。` : '';
          const debateData = [
            stage2?.userPrompt?.split('以下是一份深度分析师报告')[0]?.trim() || '',
            userViewNote,
          ].filter(Boolean).join('\n\n');

          // 降级清单：失败的角色跳过继续（裁决是核心产出，上游被截断也要尽量出裁决）
          const degraded: string[] = [];
          /** 宽容执行：失败记入 degraded 返回空串，不阻断后续阶段 */
          const safeRunOrReplay = async (stageKey: string, sys: string, usr: string, maxTokens: number, isDebate = false): Promise<string> => {
            try {
              return await runOrReplay(stageKey, sys, usr, maxTokens, isDebate);
            } catch (e: any) {
              if (e instanceof FatalApiError) throw e; // 致命 API 配置错误（key 失效/过期/模型不存在），直接冒泡不跳过
              degraded.push(stageKey);
              console.warn(`[Deep AI Proxy] ${stageKey} 失败，跳过继续：${e.message}`);
              return '';
            }
          };

          console.log('[Deep AI Proxy] Wave 1: analyst + 3 R1 debaters (parallel, tolerant)');
          // max_tokens 分级：分析师/裁决 12288（重思考，同 ranker 实测值），辩论 4096（思考量小，2倍余量防截断）
          // 分析师在后台跑，R2 反驳链不依赖分析师报告 → R1 完成后立即启动 R2，让 R2 串行耗时与分析师生成重叠（提速，质量不变）
          const analystPromise = safeRunOrReplay('analyst', stage1.systemPrompt, stage1.userPrompt, 12288);
          analystPromise.catch(() => {}); // 后台 promise 仅在用户取消时 reject，统一由后续 await 处理
          // safeRunOrReplay 已把非致命失败吞成空串，Promise.all 只让 FatalApiError 冒泡（不再 allSettled 吞致命错误）
          const [t1, r1, x1] = await Promise.all([
            safeRunOrReplay('tech', buildTechR1SystemPrompt(), debateData, 4096, true),
            safeRunOrReplay('risk', buildRiskR1SystemPrompt(), debateData, 4096, true),
            safeRunOrReplay('xinjie', buildXinJieR1DebatePrompt(isETF), debateData, 4096, true),
          ]);

          // ===== R2：串行反驳链（宽容；前一步失败用空串占位）=====
          console.log('[Deep AI Proxy] Wave 2: R2 rebuttal chain (tolerant)');
          const techR2Ctx = `前面两人的第一轮发言：\n${r1}\n${x1}\n\n请回应以上两人的观点。`;
          const techR2 = await safeRunOrReplay('tech_r2', buildTechR2RebuttalPrompt(), techR2Ctx, 4096, true);

          const riskR2Ctx = `第一轮发言回顾：\n${t1}\n${x1}\n\n技术分析师的回应：\n${techR2}\n\n请回应以上内容。`;
          const riskR2 = await safeRunOrReplay('risk_r2', buildRiskR2RebuttalPrompt(), riskR2Ctx, 4096, true);

          const xinjieR2Ctx = `第一轮：\n${t1}\n${r1}\n\n第二轮回应：\n技术分析师："${techR2.slice(0, 200)}"\n风控专家："${riskR2.slice(0, 200)}"\n\n请给出你的最终判断。`;
          const xinjieR2 = await safeRunOrReplay('xinjie_r2', buildXinJieR2RebuttalPrompt(isETF), xinjieR2Ctx, 4096, true);

          // 裁决需要分析师报告：R2 链完成后收口等分析师结束（若分析师更快，这里已 resolve）
          const stage1Output = await analystPromise;

          const r1Text = [t1, r1, x1].filter(Boolean).join('\n\n');
          const r2Text = [techR2, riskR2, xinjieR2].filter(Boolean).join('\n\n');
          const stage2Output = [r1Text, r2Text && `--- 第二轮 ---\n${r2Text}`].filter(Boolean).join('\n\n');

          // 卡死检测（仅当两轮都有内容，空串会误判相似度 1）
          if ((t1 || r1 || x1) && (techR2 || riskR2 || xinjieR2)) {
            const similarity = jaccardSimilarity(t1 + r1 + x1, techR2 + riskR2 + xinjieR2);
            if (similarity >= STUCK_THRESHOLD) {
              console.warn(`[Deep AI Proxy] 辩论轮间相似度过高 (${(similarity * 100).toFixed(0)}%)`);
              encodeSSE(encoder, controller, { stage: 'debate', warning: `辩论出现重复（相似度${(similarity * 100).toFixed(0)}%）` });
            }
          }

          // ===== 阶段三：最终裁决（三档降级重试；全失败由客户端规则兜底）=====
          console.log('[Deep AI Proxy] Stage 3: Final Verdict (with degrade)');
          const s3System = stage3?.systemPrompt || buildVerdictSystemPrompt(isETF);
          const userViewVerdict = userView ? `\n\n[用户观点] 用户当前${userView}，理由：${userViewReason || '未说明'}。请在决策理由中评价用户观点是否成立（用数据说话，不要迎合用户）。` : '';
          // P2：历史校准注入（真实回测胜率，拼在 ## 分析师报告 前；样本不足/失败返回空串）
          const calibrationNote = await buildCalibrationNote(stockCode);
          const s3Base = [
            stage3?.userPrompt?.split('## 分析师报告')[0]?.trim() || '',
            (!stage2Output && !stage1Output ? '[提示] 本次分析师报告与辩论均未能生成，请直接基于行情与结构化候选价位给出决策，无需综合评判。' : ''),
          ].filter(Boolean).join('\n\n');

          const buildS3User = (withAnalyst: boolean, withDebate: boolean, withCalibration: boolean): string => {
            const parts: string[] = [s3Base];
            if (withCalibration && calibrationNote) parts.push(calibrationNote);
            if (withAnalyst && stage1Output) parts.push(`## 分析师报告\n${stage1Output}`);
            if (withDebate && stage2Output) parts.push(`## 多空辩论\n${stage2Output}`);
            parts.push(userViewVerdict);
            parts.push('请基于以上信息，做出最终投资决策。**注意：目标价和止损价必须参考实时行情中的当前价格。**');
            return parts.filter(Boolean).join('\n\n');
          };

          // 先把降级清单发给客户端（展示"分析不完整"提示）
          if (degraded.length > 0) {
            encodeSSE(encoder, controller, { stage: 'verdict', warnings: [...degraded] });
          }
          const VERDICT_ATTEMPTS: [boolean, boolean, boolean][] = [
            [true, true, true],
            [true, false, false],
            [false, false, false],
          ];
          let verdictOk = false;
          for (let attempt = 0; attempt < VERDICT_ATTEMPTS.length; attempt++) {
            const [withAnalyst, withDebate, withCalibration] = VERDICT_ATTEMPTS[attempt];
            if (attempt > 0) {
              const hasFull = stage1Output && stage2Output;
              const sameInput = (attempt === 1 && (!stage2Output || !hasFull)) || (attempt === 2 && !stage1Output);
              if (sameInput) continue;
            }
            try {
              const usr = buildS3User(withAnalyst, withDebate, withCalibration);
              await runOrReplay('verdict', s3System, usr, 12288);
              verdictOk = true;
              break;
            } catch (e: any) {
              if (e instanceof FatalApiError) throw e; // 致命 API 配置错误，不降级重试
              degraded.push(`verdict_attempt${attempt + 1}`);
              console.warn(`[Deep AI Proxy] 裁决第${attempt + 1}档失败，降级重试：${e.message}`);
              // reset：让客户端清掉已流式的残片，防降级结果前缀重复
              encodeSSE(encoder, controller, { stage: 'verdict', reset: true });
              if (attempt >= VERDICT_ATTEMPTS.length - 1) throw e;
            }
          }
        } catch (e: any) {
          console.error('[Deep AI Proxy] 分析失败:', e.message);
          if (e instanceof FatalApiError) {
            // 致命 API 配置错误：明确报错，客户端据 fatal 标志不兜底
            encodeSSE(encoder, controller, { error: e.message, fatal: true });
          } else {
            // 裁决彻底失败：客户端收到 error 后会自动退回规则兜底，保证"最坏也有裁决"
            encodeSSE(encoder, controller, { error: `${e.message || '分析失败'}，已退回规则引擎兜底` });
          }
        } finally {
          clearInterval(heartbeat);
          endSSE(encoder, controller);
        }
      },
    });

    return sseResponse(stream);
  } catch (error: any) {
    console.error('[Deep AI Proxy] Exception:', error.message);
    return llmRouteError(error, '请求超时，AI 模型响应过慢');
  }
}
