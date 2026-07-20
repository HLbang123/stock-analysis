import { NextRequest, NextResponse } from 'next/server';
import { formatAiError } from '@/lib/ai-error';
import { buildChatUrl, buildLLMHeaders, createTimeoutSignal, llmRouteError, sseResponse } from '@/lib/llm-client';
import { readLlmDeltas, encodeSSE, endSSE } from '@/lib/llm-stream';

/** AI分析代理 — 流式SSE转发 */
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

    const url = buildChatUrl(baseUrl);
    const headers = buildLLMHeaders(apiKey);
    const { signal, clear } = createTimeoutSignal(120000);

    const llmResponse = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 8192,
        stream: true,
      }),
      signal,
    });

    clear();

    if (!llmResponse.ok) {
      const errorText = await llmResponse.text().catch(() => '');
      console.error(`[AI Proxy] Error ${llmResponse.status}: ${errorText}`);
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
          console.error('[AI Proxy] Stream read error:', e.message);
          encodeSSE(encoder, controller, '\n\n[流中断]');
        } finally {
          endSSE(encoder, controller);
        }
      },
    });

    return sseResponse(stream);
  } catch (error: any) {
    console.error('[AI Proxy] Exception:', error.message);
    return llmRouteError(error, '请求超时（120秒），AI 模型响应过慢，请稍后重试');
  }
}
