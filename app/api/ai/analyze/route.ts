import { NextRequest, NextResponse } from 'next/server';
import { formatAiError, formatNetworkError } from '@/lib/ai-error';

/**
 * AI分析代理 — 流式SSE转发
 * 将 LLM 的 stream 响应以 SSE 格式逐块推送给客户端
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { systemPrompt, userPrompt, baseUrl, apiKey, model } = body;

    if (!baseUrl || !model) {
      return NextResponse.json(
        { error: '缺少必要参数: baseUrl, model' },
        { status: 400 }
      );
    }

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    console.log(`[AI Proxy] Streaming ${url} with model ${model}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);

    const llmResponse = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.3,
        max_tokens: 8192,
        stream: true,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!llmResponse.ok) {
      const errorText = await llmResponse.text().catch(() => '');
      console.error(`[AI Proxy] Error ${llmResponse.status}: ${errorText.slice(0, 300)}`);
      return NextResponse.json(
        { error: formatAiError(llmResponse.status, errorText) },
        { status: llmResponse.status }
      );
    }

    // 创建 SSE 流
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
          console.error('[AI Proxy] Stream read error:', e.message);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify('\n\n[流中断]')}\n\n`));
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
    console.error('[AI Proxy] Exception:', error.message);
    if (error.name === 'AbortError') {
      return NextResponse.json(
        { error: '请求超时（120秒），AI 模型响应过慢，请稍后重试' },
        { status: 504 }
      );
    }
    return NextResponse.json(
      { error: formatNetworkError(error) },
      { status: 500 }
    );
  }
}
