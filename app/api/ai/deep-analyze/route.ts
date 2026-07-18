import { NextRequest, NextResponse } from 'next/server';
import { formatAiError, formatNetworkError } from '@/lib/ai-error';

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

          // ===== 阶段二：多空辩论（两轮）=====
          console.log('[Deep AI Proxy] Stage 2: Bull/Bear Debate (2 rounds)');
          let stage2Output = '';
          try {
            // Round 1: 多方初始论点 + 空方初始论点
            const s2r1System = stage2?.systemPrompt || buildFallbackDebateRound1Prompt();
            const s2r1User = [
              stage2?.userPrompt?.split('以下是一份深度分析师报告')[0]?.trim() || '',
              `以下是一份深度分析师报告，请基于这份报告进行多空辩论：\n\n${stage1Output}`,
            ].filter(Boolean).join('\n\n');
            const round1Output = await runStage('debate', s2r1System, s2r1User);
            stage2Output += round1Output;

            // Round 2: 多方反驳 + 空方反驳 + 研究经理综合评判
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ stage: 'debate', text: '\n\n--- 第二轮 ---\n\n' })}\n\n`
              )
            );

            const s2r2System = stage2?.systemPrompt || buildFallbackDebateRound2Prompt();
            const s2r2User = `以下为第一轮多空辩论的完整记录：\n\n${round1Output}\n\n请基于第一轮辩论内容，进行第二轮反驳和综合评判。`;
            const round2Output = await runStage('debate', s2r2System, s2r2User);
            stage2Output += '\n\n--- 第二轮 ---\n\n' + round2Output;

            // 卡死检测：两轮辩论相似度
            const similarity = jaccardSimilarity(round1Output, round2Output);
            if (similarity >= STUCK_THRESHOLD) {
              console.warn(`[Deep AI Proxy] 辩论轮间相似度过高 (${(similarity * 100).toFixed(0)}%)`);
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ stage: 'debate', warning: `辩论出现重复（相似度${(similarity*100).toFixed(0)}%），两轮论点高度雷同` })}\n\n`
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

/** 备用：第一轮辩论 prompt（角色人格化版本） */
function buildFallbackDebateRound1Prompt(): string {
  return `你现在是投资辩论主持人。请依次扮演以下两个角色，进行第一轮辩论。

## 角色设定

### 技术分析师（看涨立场）
口头禅风格："K线图清楚地告诉我..."、"量价关系来看..."

### 风险控制专家（看跌立场）
口头禅风格："作为风控专家，我必须泼一盆冷水..."、"风险点在于..."

## 行为禁令
- 禁止搜索新数据——你已经有分析师报告和实时行情
- 禁止中立摇摆——必须明确选一边

## 第一轮

### 技术分析师（看涨论点）
以"【看涨观点】"开头，150-250字：
- 引用具体数据（价格、均线、成交量、资金流向等）
- 用第一人称："我发现"、"我认为"

### 风险控制专家（看跌论点）
以"【看跌观点】"开头，150-250字：
- 必须直接针对技术分析师的论点进行质疑
- 用第一人称："我担心"、"我不同意"

注意：严格遵守角色切换。`;
}

/** 备用：第二轮辩论 prompt（累计上下文 + 5 级情绪强度） */
function buildFallbackDebateRound2Prompt(): string {
  return `你现在是投资辩论主持人。必须引用并回应对方第一轮的具体论点。

## 第二轮

### 技术分析师反驳
以"【看涨反驳】"开头（100-200字）：
- 逐条回应风控专家第一轮的质疑
- 直接称呼对方："风控专家提到...，但事实上..."

### 风险控制专家反驳
以"【看跌反驳】"开头（100-200字）：
- 逐条回应技术分析师第一轮的论点
- 直接称呼对方："技术分析师认为...，但我必须指出..."

### 研究经理综合评判
以"【综合评判】"开头（100-200字）：
- 对比双方论点说服力
- 给出 5 级情绪强度（五选一）：强烈看多 / 温和看多 / 中性 / 温和看空 / 强烈看空

注意：反驳必须真实引用对方论点。`;
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
