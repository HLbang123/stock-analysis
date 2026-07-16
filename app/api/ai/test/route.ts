import { NextRequest, NextResponse } from 'next/server';
import { formatAiError, formatNetworkError } from '@/lib/ai-error';

/**
 * 代理测试AI连接
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { baseUrl, apiKey, model } = body;

    if (!baseUrl || !model) {
      return NextResponse.json(
        { error: '缺少必要参数' },
        { status: 400 }
      );
    }

    const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const startTime = Date.now();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 5,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const latency = Date.now() - startTime;

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error(`[AI Test] ${response.status}: ${text.slice(0, 300)}`);
      return NextResponse.json({
        success: false,
        message: formatAiError(response.status, text),
        latencyMs: latency,
      });
    }

    return NextResponse.json({
      success: true,
      message: `连接成功 (${latency}ms)`,
      latencyMs: latency,
    });
  } catch (error: any) {
    console.error('[AI Test] Network error:', error.message);
    return NextResponse.json({
      success: false,
      message: formatNetworkError(error),
      latencyMs: 0,
    });
  }
}
