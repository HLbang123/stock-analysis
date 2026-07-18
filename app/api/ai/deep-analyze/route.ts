import { NextRequest, NextResponse } from 'next/server';
import { formatAiError, formatNetworkError } from '@/lib/ai-error';
import { buildChatUrl, buildLLMHeaders, createTimeoutSignal, llmRouteError, sseResponse, defuseLongDigitRuns } from '@/lib/llm-client';
import { readLlmDeltas, encodeSSE, endSSE } from '@/lib/llm-stream';
import {
  buildTechR1SystemPrompt, buildRiskR1SystemPrompt,
  buildXinJieR1DebatePrompt, buildXinJieR2RebuttalPrompt,
  buildTechR2RebuttalPrompt, buildRiskR2RebuttalPrompt,
  buildManagerPrompt, buildVerdictSystemPrompt,
} from '@/services/deepAnalysisPrompt';

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
    const { stage1, stage2, stage3, baseUrl, apiKey, model, completed } = body;

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
        /** 执行一个阶段的 LLM 调用，流式输出到客户端，返回完整输出文本。任何失败最终都抛出（带 [stage] 前缀） */
        async function runStage(stageKey: string, systemPrompt: string, userPrompt: string, maxTokens = 4096, attempt = 1): Promise<string> {
          let fullOutput = '';
          const { signal, clear } = createTimeoutSignal(120000);

          try {
            const llmResponse = await fetch(url, {
              method: 'POST',
              headers: llmHeaders,
              body: JSON.stringify({
                model,
                messages: [
                  { role: 'system', content: defuseLongDigitRuns(systemPrompt) },
                  { role: 'user', content: defuseLongDigitRuns(userPrompt) },
                ],
                temperature: 0.3,
                max_tokens: maxTokens,
                stream: true,
              }),
              signal,
            });

            clear();

            if (!llmResponse.ok) {
              const errorText = await llmResponse.text().catch(() => '');
              console.error(`[Deep AI Proxy] ${stageKey} HTTP ${llmResponse.status}: ${errorText}`);
              // 限流 / 服务端错误：退避重试
              if (attempt < 3 && (llmResponse.status === 429 || llmResponse.status >= 500)) {
                const backoff = 2000 * attempt;
                console.warn(`[Deep AI Proxy] ${stageKey} HTTP ${llmResponse.status}，${backoff}ms 后重试 ${attempt}/2`);
                await new Promise(r => setTimeout(r, backoff));
                return runStage(stageKey, systemPrompt, userPrompt, maxTokens, attempt + 1);
              }
              throw new Error(`[${stageKey}] ${formatAiError(llmResponse.status, errorText)}`);
            }

            let lastDelta = '';
            let repeatCount = 0;
            let stuckWarning = false;

            await readLlmDeltas(llmResponse, (delta) => {
              // 卡死检测：连续相同输出
              if (delta === lastDelta) {
                repeatCount++;
              } else {
                repeatCount = 0;
                lastDelta = delta;
              }
              if (repeatCount >= 3 && !stuckWarning) {
                stuckWarning = true;
                console.warn(`[Deep AI Proxy] ${stageKey} 检测到卡死（连续重复输出）`);
                encodeSSE(encoder, controller, { stage: stageKey, warning: '检测到输出重复，可能陷入循环' });
              }

              fullOutput += delta;
              encodeSSE(encoder, controller, { stage: stageKey, text: delta });
            });

            // 空输出：模型异常，重试；仍空则抛出
            if (!fullOutput.trim()) {
              if (attempt < 3) {
                console.warn(`[Deep AI Proxy] ${stageKey} 输出为空，重试 ${attempt}/2`);
                return runStage(stageKey, systemPrompt, userPrompt, maxTokens, attempt + 1);
              }
              throw new Error(`[${stageKey}] 输出为空`);
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
              throw new Error(`[${stageKey}] 阶段超时（120s），模型未在限定时间内响应`);
            }
            if (attempt < 3 && (e.message?.includes('fetch failed') || e.name === 'TypeError')) {
              const backoff = 2000 * attempt;
              console.warn(`[Deep AI Proxy] ${stageKey} 网络错误，${backoff}ms 后重试 ${attempt}/2`);
              await new Promise(r => setTimeout(r, backoff));
              return runStage(stageKey, systemPrompt, userPrompt, maxTokens, attempt + 1);
            }
            // 已带 [stageKey] 前缀的错误直接抛，否则用 formatNetworkError 翻译网络原因
            throw e.message?.startsWith(`[${stageKey}]`)
              ? e
              : new Error(`[${stageKey}] ${formatNetworkError(e)}`);
          }

          encodeSSE(encoder, controller, { stage: stageKey, done: true });
          return fullOutput;
        }

        /** 断点续传：命中缓存（completed[stageKey]）则回放文本跳过 LLM 调用，否则正常执行 runStage */
        async function runOrReplay(stageKey: string, sys: string, usr: string, maxTokens: number, isDebate = false): Promise<string> {
          const cached = completed?.[stageKey];
          if (cached != null) {
            if (isDebate) {
              encodeSSE(encoder, controller, { stage: 'debate', role: stageKey, text: cached + '\n\n' });
            } else {
              encodeSSE(encoder, controller, { stage: stageKey, text: cached });
              encodeSSE(encoder, controller, { stage: stageKey, done: true });
            }
            console.log(`[Deep AI Proxy] ${stageKey} 命中缓存，跳过 LLM 调用`);
            return cached;
          }
          const text = await runStage(stageKey, sys, usr, maxTokens);
          if (isDebate) {
            encodeSSE(encoder, controller, { stage: 'debate', role: stageKey, text: text + '\n\n' });
          }
          return text;
        }

        try {
          // ===== 阶段一：情报收集 =====
          console.log('[Deep AI Proxy] Stage 1: Analyst Report');
          const stage1Output = await runOrReplay('analyst', stage1.systemPrompt, stage1.userPrompt, 4096);

          // ===== 阶段二：多空辩论（任一角色失败即终止整次分析）=====
          console.log('[Deep AI Proxy] Stage 2: 3-person debate');
          let stage2Output = '';
          // 辩论基础数据 prompt（不含分析师报告，角色不需要读完整报告）
          const debateData = [
            stage2?.userPrompt?.split('以下是一份深度分析师报告')[0]?.trim() || '',
          ].filter(Boolean).join('\n\n');

          // ======== Round 1: 三人串行（一条一条出，避免并发压垮中转站）========
          const t1 = await runOrReplay('tech', buildTechR1SystemPrompt(), debateData, 2048, true);
          const r1 = await runOrReplay('risk', buildRiskR1SystemPrompt(), debateData, 2048, true);
          const x1 = await runOrReplay('xinjie', buildXinJieR1DebatePrompt(), debateData, 2048, true);
          stage2Output += [t1, r1, x1].join('\n\n');

          // ======== Round 2: 串行反驳（累计上下文）========
          encodeSSE(encoder, controller, { stage: 'debate', text: '\n--- 第二轮 ---\n' });

          const techR2Ctx = `前面两人的第一轮发言：\n${r1}\n${x1}\n\n请回应以上两人的观点。`;
          const techR2 = await runOrReplay('tech_r2', buildTechR2RebuttalPrompt(), techR2Ctx, 2048, true);

          const riskR2Ctx = `第一轮发言回顾：\n${t1}\n${x1}\n\n技术分析师的回应：\n${techR2}\n\n请回应以上内容。`;
          const riskR2 = await runOrReplay('risk_r2', buildRiskR2RebuttalPrompt(), riskR2Ctx, 2048, true);

          const xinjieR2Ctx = `第一轮：\n${t1}\n${r1}\n\n第二轮回应：\n技术分析师："${techR2.slice(0, 200)}"\n风控专家："${riskR2.slice(0, 200)}"\n\n请给出你的最终判断。`;
          const xinjieR2 = await runOrReplay('xinjie_r2', buildXinJieR2RebuttalPrompt(), xinjieR2Ctx, 2048, true);

          const mgrCtx = `第一轮发言：\n技术分析师：${t1.slice(0, 200)}\n风控专家：${r1.slice(0, 200)}\n心姐：${x1.slice(0, 200)}\n\n第二轮反驳：\n技术反驳：${techR2.slice(0, 200)}\n风控反驳：${riskR2.slice(0, 200)}\n心姐最终判断：${xinjieR2.slice(0, 200)}`;
          const mgrOutput = await runOrReplay('manager', buildManagerPrompt(), mgrCtx, 2048, true);

          stage2Output += '\n--- R2 ---\n' + [techR2, riskR2, xinjieR2, mgrOutput].join('\n\n');

          // 卡死检测：R1 vs R2 相似度
          const r1All = t1 + r1 + x1;
          const similarity = jaccardSimilarity(r1All, techR2 + riskR2 + xinjieR2);
          if (similarity >= STUCK_THRESHOLD) {
            console.warn(`[Deep AI Proxy] 辩论轮间相似度过高 (${(similarity * 100).toFixed(0)}%)`);
            encodeSSE(encoder, controller, { stage: 'debate', warning: `辩论出现重复（相似度${(similarity * 100).toFixed(0)}%）` });
          }

          // ===== 阶段三：最终裁决 =====
          console.log('[Deep AI Proxy] Stage 3: Final Verdict');
          const s3System = stage3?.systemPrompt || buildVerdictSystemPrompt();
          const s3User = [
            stage3?.userPrompt?.split('## 分析师报告')[0]?.trim() || '',
            `## 分析师报告\n${stage1Output}`,
            `## 多空辩论\n${stage2Output}`,
            '请基于以上信息，做出最终投资决策。**注意：目标价和止损价必须参考实时行情中的当前价格。**',
          ].filter(Boolean).join('\n\n');
          await runOrReplay('verdict', s3System, s3User, 4096);
        } catch (e: any) {
          console.error('[Deep AI Proxy] 分析失败:', e.message);
          encodeSSE(encoder, controller, { error: `${e.message || '分析失败'}，可点击"继续生成"从断点恢复` });
        } finally {
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
