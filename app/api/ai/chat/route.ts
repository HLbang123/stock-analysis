import { NextRequest, NextResponse } from 'next/server';
import { formatAiError } from '@/lib/ai-error';
import { buildChatUrl, buildLLMHeaders, createTimeoutSignal, llmRouteError, sseResponse, defuseLongDigitRuns } from '@/lib/llm-client';
import { readLlmDeltas, encodeSSE, endSSE } from '@/lib/llm-stream';

const CHAT_SYSTEM_PROMPT = `你是A股投资分析助手。你可以：
1. 回答关于技术分析、K线形态、均线系统、MACD/RSI等指标的问题
2. 解读股票数据和预警信号，给出客观分析
3. 提供投资知识科普和交易策略参考
4. 帮用户梳理自己的投资思路

原则：
- 回答简洁专业，中文
- 如果提供了股票数据，结合具体数据分析
- 不推荐具体买卖操作，只做分析和建议
- 不确定的事情要诚实说明`;

/** AI 对话代理 — SSE 流式，支持多轮对话 + 可选股票上下文 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { messages, stockContext, baseUrl, apiKey, model } = body;

    if (!baseUrl || !model) {
      return NextResponse.json(
        { error: '缺少必要参数: baseUrl, model' },
        { status: 400 }
      );
    }

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json(
        { error: '缺少 messages 参数' },
        { status: 400 }
      );
    }

    let systemContent = CHAT_SYSTEM_PROMPT;
    if (stockContext) {
      systemContent += `\n\n## 当前附带的股票数据\n${stockContext}`;
    }

    const allMessages = [{ role: 'system', content: systemContent }, ...messages];

    const url = buildChatUrl(baseUrl);
    const headers = buildLLMHeaders(apiKey);
    const { signal, clear } = createTimeoutSignal(120000);

    let llmResponse: Response;
    try {
      llmResponse = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages: allMessages.map(m => ({ role: m.role, content: defuseLongDigitRuns(m.content) })),
          temperature: 0.7,
          max_tokens: 4096,
          stream: true,
        }),
        signal,
      });
    } finally {
      clear();
    }

    if (!llmResponse.ok) {
      const errorText = await llmResponse.text().catch(() => '');
      console.error(`[Chat Proxy] Error ${llmResponse.status}: ${errorText.slice(0, 300)}`);
      return NextResponse.json(
        { error: formatAiError(llmResponse.status, errorText) },
        { status: llmResponse.status }
      );
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          await readLlmDeltas(llmResponse, (delta) => encodeSSE(encoder, controller, delta));
        } catch (e: any) {
          console.error('[Chat Proxy] Stream read error:', e.message);
        } finally {
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
