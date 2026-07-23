import { NextRequest, NextResponse } from 'next/server';
import { formatAiError } from '@/lib/ai-error';
import { buildChatUrl, buildLLMHeaders, createTimeoutSignal, llmRouteError, sseResponse } from '@/lib/llm-client';
import { readLlmDeltas, encodeSSE, endSSE } from '@/lib/llm-stream';
import { CHAT_TOOLS, executeTool } from '@/lib/chat-tools';
import { getProvider } from '@/lib/llm/providers';

const CHAT_SYSTEM_PROMPT = `你是A股投资分析助手。你可以：
1. 回答关于技术分析、K线形态、均线系统、MACD/RSI等指标的问题
2. 解读股票数据和预警信号，给出客观分析
3. 提供投资知识科普和交易策略参考
4. 帮用户梳理自己的投资思路

你可以使用工具查询实时数据（行情、K线、RPS、市场宽度、北向资金、选股扫描）。
当用户问某只股票、某天数据、大盘情况时，主动调用工具获取最新数据再回答。

原则：
- 回答简洁专业，中文
- 有数据时结合数据分析，不凭空猜测
- 不推荐具体买卖操作，只做分析和建议
- 不确定的事情要诚实说明`;

/** AI 对话代理 — SSE 流式，支持 Function Calling + 多轮对话 + 可选股票上下文
 *  一进来就开 SSE 流，工具调用期间每 15s 发心跳注释保活，
 *  防止 CF 代理 / 移动网络的空闲超时（~100s）掐断非流式的工具调用阶段。 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { messages, stockContext, baseUrl, apiKey, model } = body;

    if (!baseUrl || !model) {
      return NextResponse.json({ error: '缺少必要参数: baseUrl, model' }, { status: 400 });
    }
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json({ error: '缺少 messages 参数' }, { status: 400 });
    }

    let systemContent = CHAT_SYSTEM_PROMPT;
    if (stockContext) {
      systemContent += `\n\n## 当前附带的股票数据\n${stockContext}`;
    }

    const allMessages: any[] = [{ role: 'system', content: systemContent }, ...messages];
    const url = buildChatUrl(baseUrl);
    const headers = buildLLMHeaders(apiKey);
    const origin = new URL(request.url).origin;
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        // 心跳：SSE 注释行（: 开头），客户端自动忽略，CF 视作数据流动重置空闲计时
        const heartbeat = setInterval(() => {
          try { controller.enqueue(encoder.encode(': keepalive\n\n')); } catch { /* 流已关闭 */ }
        }, 15000);

        const useTools = getProvider(baseUrl, model).supportsTools(model);
        try {
          // 多轮工具调用（最多 3 轮）：每轮非流式调 LLM，有 tool_calls 就执行后继续，没有就把答案写入流
          // reasoning 模型（deepseek-reasoner / glm-z1 / o1 等）不支持 function calling → useTools=false，循环不执行，直接走 streamFinalAnswer
          let resolved = false;
          for (let round = 0; round < 3 && useTools; round++) {
            let toolData: any = null;
            try {
              const { signal, clear } = createTimeoutSignal(60000);
              const toolRes = await fetch(url, {
                method: 'POST', headers,
                body: JSON.stringify({
                  model, messages: allMessages,
                  tools: CHAT_TOOLS, tool_choice: 'auto',
                  temperature: 0.7, max_tokens: 4096,
                }),
                signal,
              });
              clear();
              if (toolRes.ok) toolData = await toolRes.json();
              else break; // API 不支持工具或出错，降级流式
            } catch {
              break; // 网络/超时，降级流式
            }

            const choice = toolData?.choices?.[0];
            const toolCalls = choice?.message?.tool_calls;

            if (!toolCalls || toolCalls.length === 0) {
              // 不再调工具 → content 就是答案
              const content = choice?.message?.content || "";
              if (content) {
                encodeSSE(encoder, controller, content);
                resolved = true;
              }
              break; // 空内容，降级流式
            }

            // 执行工具调用
            allMessages.push(choice.message);
            for (const tc of toolCalls) {
              const args = JSON.parse(tc.function?.arguments || '{}');
              const result = await executeTool(tc.function.name, args, origin);
              allMessages.push({ role: 'tool', tool_call_id: tc.id, content: result });
            }
            // 继续下一轮（LLM 拿到工具结果后可能再调工具，或给出最终答案）
          }

          // 3 轮用尽或降级且未直接拿到答案 → 最终流式输出（不带工具，强制文字回答）
          if (!resolved) {
            await streamFinalAnswer(url, headers, model, allMessages, encoder, controller);
          }
        } catch (e: any) {
          console.error('[Chat Proxy] Stream exception:', e.message);
          // 流已开启无法回 JSON，以文本形式把错误送到客户端展示
          encodeSSE(encoder, controller, `⚠️ AI 请求失败：${e.message || '未知错误'}`);
        } finally {
          clearInterval(heartbeat);
          endSSE(encoder, controller);
        }
      },
    });

    return sseResponse(stream);
  } catch (error: any) {
    console.error('[Chat Proxy] Exception:', error.message);
    return llmRouteError(error, '请求超时（120秒）');
  }
}

/** 最终流式调用 LLM（不带工具），把 delta 直接写入已开启的 SSE 流。失败时写错误文本。 */
async function streamFinalAnswer(
  url: string,
  headers: Record<string, string>,
  model: string,
  messages: any[],
  encoder: TextEncoder,
  controller: ReadableStreamDefaultController,
): Promise<void> {
  const { signal, clear } = createTimeoutSignal(120000);
  let llmResponse: Response;
  try {
    llmResponse = await fetch(url, {
      method: 'POST', headers,
      body: JSON.stringify({
        model, messages,
        temperature: 0.7, max_tokens: 4096,
        stream: true,
      }),
      signal,
    });
  } catch (e: any) {
    clear();
    encodeSSE(encoder, controller, `⚠️ AI 请求失败：${formatAiError(500, e.message)}`);
    return;
  }
  clear();

  if (!llmResponse.ok) {
    const errorText = await llmResponse.text().catch(() => '');
    encodeSSE(encoder, controller, `⚠️ AI 请求失败：${formatAiError(llmResponse.status, errorText)}`);
    return;
  }

  await readLlmDeltas(llmResponse, (d) => {
    if (d.content) encodeSSE(encoder, controller, d.content);
    if (d.reasoning) encodeSSE(encoder, controller, { reasoning: d.reasoning });
  });
}
