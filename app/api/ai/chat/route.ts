import { NextRequest, NextResponse } from 'next/server';
import { formatAiError, formatNetworkError } from '@/lib/ai-error';

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

/**
 * AI 对话代理 — SSE 流式，支持多轮对话 + 可选股票上下文
 */
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

    // 构建消息列表
    let systemContent = CHAT_SYSTEM_PROMPT;
    if (stockContext) {
      systemContent += `\n\n## 当前附带的股票数据\n${stockContext}`;
    }

    const allMessages = [
      { role: 'system', content: systemContent },
      ...messages,
    ];

    const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    console.log(`[Chat Proxy] ${url} model=${model} messages=${allMessages.length}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);

    let llmResponse: Response;
    try {
      llmResponse = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages: allMessages,
          temperature: 0.7,
          max_tokens: 4096,
          stream: true,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
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
        const reader = llmResponse.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
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
              if (data === '[DONE]') {
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                continue;
              }

              try {
                const parsed = JSON.parse(data);
                const delta = parsed.choices?.[0]?.delta?.content;
                if (delta) {
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(delta)}\n\n`));
                }
              } catch {
                // 跳过无法解析的行
              }
            }
          }
        } catch (e: any) {
          console.error('[Chat Proxy] Stream read error:', e.message);
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
    console.error('[Chat Proxy] Exception:', error.message);
    if (error.name === 'AbortError') {
      return NextResponse.json(
        { error: '请求超时（120秒）' },
        { status: 504 }
      );
    }
    return NextResponse.json(
      { error: formatNetworkError(error) },
      { status: 500 }
    );
  }
}
