import { NextRequest, NextResponse } from 'next/server';
import { formatAiError, formatNetworkError } from '@/lib/ai-error';

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

          // ===== 阶段二：多空辩论 =====
          console.log('[Deep AI Proxy] Stage 2: Bull/Bear Debate');
          let stage2Output = '';
          try {
            // 动态构建 stage2 prompt，注入阶段一输出
            const s2System = stage2?.systemPrompt || buildFallbackDebatePrompt();
            const s2User = [
              stage2?.userPrompt?.split('以下是一份深度分析师报告')[0]?.trim() || '',
              `以下是一份深度分析师报告，请基于这份报告进行多空辩论：\n\n${stage1Output}`,
            ].filter(Boolean).join('\n\n');
            stage2Output = await runStage('debate', s2System, s2User);
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

/** 备用：如果客户端未传入阶段二 prompt */
function buildFallbackDebatePrompt(): string {
  return `你是投资辩论主持人。请基于分析师报告进行多空辩论。

## 辩论流程

### 多方研究员
以"【多方观点】"开头，列出3-5个看涨理由。200-300字。

###  空方研究员
以"【空方观点】"开头，列出3-5个看跌理由，直接反驳多方。200-300字。

### 研究经理
以"【综合评判】"开头，给出偏多/偏空/中性的判断及依据。150-250字。`;
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
