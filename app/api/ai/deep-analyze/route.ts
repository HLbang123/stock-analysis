import { NextRequest, NextResponse } from 'next/server';
import { formatAiError, formatNetworkError } from '@/lib/ai-error';
import {
  buildTechR1SystemPrompt, buildRiskR1SystemPrompt,
  buildXinJieR1DebatePrompt, buildXinJieR2RebuttalPrompt,
  buildTechR2RebuttalPrompt, buildRiskR2RebuttalPrompt,
  buildManagerPrompt,
} from '@/services/deepAnalysisPrompt';

/**
 * Jaccard 相似度（bigram 分词）
 * 用于检测辩论轮间的卡死（输出高度重复）
 */
function jaccardSimilarity(a: string, b: string): number {
  const bigrams = (s: string) => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) {
      set.add(s.slice(i, i + 2));
    }
    return set;
  };
  const sa = bigrams(a);
  const sb = bigrams(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let intersection = 0;
  for (const gram of sa) {
    if (sb.has(gram)) intersection++;
  }
  return intersection / (sa.size + sb.size - intersection);
}

/** 卡死检测阈值：相似度 > 0.7 视为卡死 */
const STUCK_THRESHOLD = 0.7;

/**
 * 深度分析代理 — 三阶段 SSE 流式编排
 * 阶段一：情报收集 → 阶段二：多空辩论 → 阶段三：最终裁决
 * 每个阶段独立调用 LLM，流式输出到客户端
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { stage1, stage2, stage3, baseUrl, apiKey, model } = body;

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

    const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
    const llmHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) {
      llmHeaders['Authorization'] = `Bearer ${apiKey}`;
    }

    console.log(`[Deep AI Proxy] Starting 3-stage analysis with model ${model}`);

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        /**
         * 执行一个阶段的 LLM 调用，流式输出到客户端
         * @returns 该阶段的完整输出文本
         */
        async function runStage(
          stageKey: string,
          systemPrompt: string,
          userPrompt: string
        ): Promise<string> {
          let fullOutput = '';

          const stageController = new AbortController();
          const timeout = setTimeout(() => stageController.abort(), 90000);

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
                max_tokens: 4096,
                stream: true,
              }),
              signal: stageController.signal,
            });

            clearTimeout(timeout);

            if (!llmResponse.ok) {
              const errorText = await llmResponse.text().catch(() => '');
              console.error(`[Deep AI Proxy] ${stageKey} HTTP ${llmResponse.status}: ${errorText.slice(0, 300)}`);
              throw new Error(formatAiError(llmResponse.status, errorText));
            }

            const reader = llmResponse.body!.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let lastDelta = '';
            let repeatCount = 0;
            let stuckWarning = false;

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';

              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data:')) continue;

                const data = trimmed.slice(5).trim();
                if (data === '[DONE]') continue;

                try {
                  const parsed = JSON.parse(data);
                  const delta = parsed.choices?.[0]?.delta?.content;
                  if (delta) {
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
                      controller.enqueue(
                        encoder.encode(
                          `data: ${JSON.stringify({ stage: stageKey, warning: '检测到输出重复，可能陷入循环' })}\n\n`
                        )
                      );
                    }

                    fullOutput += delta;
                    controller.enqueue(
                      encoder.encode(
                        `data: ${JSON.stringify({ stage: stageKey, text: delta })}\n\n`
                      )
                    );
                  }
                } catch {
                  // 跳过无法解析的行
                }
              }
            }
          } catch (e: any) {
            clearTimeout(timeout);
            if (e.name === 'AbortError') {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ stage: stageKey, error: '阶段超时（90s）' })}\n\n`
                )
              );
            } else {
              throw e; // 抛给外层处理
            }
          }

          // 阶段完成标记
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ stage: stageKey, done: true })}\n\n`
            )
          );
          return fullOutput;
        }

        try {
          // ===== 阶段一：情报收集 =====
          console.log('[Deep AI Proxy] Stage 1: Analyst Report');
          const stage1Output = await runStage(
            'analyst',
            stage1.systemPrompt,
            stage1.userPrompt
          );

          if (!stage1Output.trim()) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ error: '阶段一返回为空，分析终止' })}\n\n`
              )
            );
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
            return;
          }

          // ===== 阶段二：多空辩论（Parallel R1 + Sequential R2）=====
          console.log('[Deep AI Proxy] Stage 2: 3-person debate (Parallel R1 + Sequential R2)');
          let stage2Output = '';
          try {
            // 构建辩论基础数据 prompt（不含分析师报告，角色不需要读完整报告）
            const debateData = [
              stage2?.userPrompt?.split('以下是一份深度分析师报告')[0]?.trim() || '',
            ].filter(Boolean).join('\n\n');

            // ======== Round 1: 三人并行（互不可见）========
            const [techR1, riskR1, xinjieR1] = await Promise.all([
              runStage('tech', buildTechR1SystemPrompt(), debateData),
              runStage('risk', buildRiskR1SystemPrompt(), debateData),
              runStage('xinjie', buildXinJieR1DebatePrompt(), debateData),
            ]);

            // 发送 Round 1 结果
            for (const [role, text] of [['tech', techR1], ['risk', riskR1], ['xinjie', xinjieR1]] as const) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ stage: 'debate', role, text: `【${role === 'tech' ? '看涨观点' : role === 'risk' ? '看跌观点' : '心姐判断'}】\n${text}\n\n` })}\n\n`
                )
              );
            }
            stage2Output += techR1 + '\n\n' + riskR1 + '\n\n' + xinjieR1;

            // ======== Round 2: 串行反驳（累计上下文）========
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ stage: 'debate', text: '\n--- 第二轮 ---\n' })}\n\n`
              )
            );

            // 技术反驳（看到风控+心姐的 R1）
            const techR2Ctx = `前面两人的第一轮发言：\n【看跌观点】${riskR1}\n【心姐判断】${xinjieR1}\n\n请针对以上两人的观点进行反驳。`;
            const techR2 = await runStage('tech_r2', buildTechR2RebuttalPrompt(), techR2Ctx);
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ stage: 'debate', role: 'tech_r2', text: `【看涨反驳】\n${techR2}\n\n` })}\n\n`
              )
            );

            // 风控反驳（看到技术+心姐的 R1 + 技术 R2）
            const riskR2Ctx = `第一轮发言回顾：\n【看涨观点】${techR1}\n【心姐判断】${xinjieR1}\n\n技术分析师的反驳：\n${techR2}\n\n请针对以上内容进行反驳。`;
            const riskR2 = await runStage('risk_r2', buildRiskR2RebuttalPrompt(), riskR2Ctx);
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ stage: 'debate', role: 'risk_r2', text: `【看跌反驳】\n${riskR2}\n\n` })}\n\n`
              )
            );

            // 心姐反驳（看到全部）
            const xinjieR2Ctx = `第一轮：\n【看涨观点】${techR1}\n【看跌观点】${riskR1}\n\n第二轮反驳：\n技术分析师："${techR2.slice(0, 200)}"\n风控专家："${riskR2.slice(0, 200)}"\n\n请给出你的最终判断。`;
            const xinjieR2 = await runStage('xinjie_r2', buildXinJieR2RebuttalPrompt(), xinjieR2Ctx);
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ stage: 'debate', role: 'xinjie_r2', text: `【心姐最终判断】\n${xinjieR2}\n\n` })}\n\n`
              )
            );

            // 研究经理
            const mgrCtx = `第一轮发言：\n技术分析师：${techR1.slice(0, 200)}\n风控专家：${riskR1.slice(0, 200)}\n心姐：${xinjieR1.slice(0, 200)}\n\n第二轮反驳：\n技术反驳：${techR2.slice(0, 200)}\n风控反驳：${riskR2.slice(0, 200)}\n心姐最终判断：${xinjieR2.slice(0, 200)}`;
            const mgrOutput = await runStage('manager', buildManagerPrompt(), mgrCtx);
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ stage: 'debate', role: 'manager', text: `【综合评判】\n${mgrOutput}` })}\n\n`
              )
            );

            stage2Output += '\n--- R2 ---\n' + [techR2, riskR2, xinjieR2, mgrOutput].join('\n\n');

            // 卡死检测：R1 vs R2 相似度
            const r1All = techR1 + riskR1 + xinjieR1;
            const similarity = jaccardSimilarity(r1All, techR2 + riskR2 + xinjieR2);
            if (similarity >= STUCK_THRESHOLD) {
              console.warn(`[Deep AI Proxy] 辩论轮间相似度过高 (${(similarity * 100).toFixed(0)}%)`);
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ stage: 'debate', warning: `辩论出现重复（相似度${(similarity*100).toFixed(0)}%）` })}\n\n`
                )
              );
            }
          } catch (e: any) {
            console.error('[Deep AI Proxy] Stage 2 failed:', e.message);
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ stage: 'debate', error: '辩论环节失败，继续分析' })}\n\n`
              )
            );
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ stage: 'debate', done: true })}\n\n`
              )
            );
          }

          // ===== 阶段三：最终裁决 =====
          console.log('[Deep AI Proxy] Stage 3: Final Verdict');
          try {
            // 动态构建 stage3 prompt，注入阶段一和阶段二的输出
            const s3System = stage3?.systemPrompt || buildFallbackVerdictPrompt();
            const s3User = [
              stage3?.userPrompt?.split('## 分析师报告')[0]?.trim() || '',
              `## 分析师报告\n${stage1Output}`,
              `## 多空辩论\n${stage2Output || '(辩论环节跳过)'}`,
              '请基于以上信息，做出最终投资决策。**注意：目标价和止损价必须参考实时行情中的当前价格。**',
            ].filter(Boolean).join('\n\n');
            await runStage('verdict', s3System, s3User);
          } catch (e: any) {
            console.error('[Deep AI Proxy] Stage 3 failed:', e.message);
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ stage: 'verdict', error: '决策环节失败' })}\n\n`
              )
            );
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ stage: 'verdict', done: true })}\n\n`
              )
            );
          }
        } catch (e: any) {
          console.error('[Deep AI Proxy] Fatal error:', e.message);
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ error: e.message || '分析失败' })}\n\n`
            )
          );
        } finally {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error: any) {
    console.error('[Deep AI Proxy] Exception:', error.message);
    if (error.name === 'AbortError') {
      return NextResponse.json(
        { error: '请求超时，AI 模型响应过慢' },
        { status: 504 }
      );
    }
    return NextResponse.json(
      { error: formatNetworkError(error) },
      { status: 500 }
    );
  }
}


/** 备用：如果客户端未传入阶段三 prompt */
function buildFallbackVerdictPrompt(): string {
  return `你是首席风险管理官。基于分析报告和辩论结果，做出最终投资决策。

## 决策格式（严格遵守）

ACTION:（买入/持有/卖出）
RISK_LEVEL:（高风险/中风险/低风险）
CONFIDENCE:（0-100的整数）
TARGET_LOW:（目标价下限）
TARGET_HIGH:（目标价上限）
STOP_LOSS:（止损价）
POSITION:（建议仓位百分比，如20%）

---
### 决策理由
（200-300字）

### 操作计划
（100-200字）

### 风险提示
（100-150字）`;
}
