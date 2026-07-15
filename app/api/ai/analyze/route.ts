import { NextRequest, NextResponse } from 'next/server';

/**
 * AI分析代理 — 避免浏览器暴露API Key
 * 转发到 OpenAI 兼容的 LLM API
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

    console.log(`[AI Proxy] Calling ${url} with model ${model}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.3,
        max_tokens: 8192,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      console.error(`[AI Proxy] Error ${response.status}: ${errorText.slice(0, 200)}`);
      return NextResponse.json(
        { error: `API请求失败 (${response.status})` },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error: any) {
    console.error('[AI Proxy] Exception:', error.message);
    if (error.name === 'AbortError') {
      return NextResponse.json(
        { error: '请求超时（120秒），AI模型响应过慢' },
        { status: 504 }
      );
    }
    return NextResponse.json(
      { error: `代理请求失败: ${error.message}` },
      { status: 500 }
    );
  }
}
