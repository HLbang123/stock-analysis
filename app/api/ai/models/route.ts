import { NextRequest, NextResponse } from 'next/server';
import { formatAiError, formatNetworkError } from '@/lib/ai-error';

/**
 * 代理获取模型列表
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { baseUrl, apiKey } = body;

    if (!baseUrl) {
      return NextResponse.json({ error: '缺少 Base URL' }, { status: 400 });
    }

    const url = `${baseUrl.replace(/\/$/, '')}/models`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const response = await fetch(url, { headers });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error(`[AI Models] ${response.status}: ${text.slice(0, 300)}`);
      return NextResponse.json(
        { error: formatAiError(response.status, text) },
        { status: response.status }
      );
    }

    const data = await response.json();
    const models = (data.data || [])
      .map((m: any) => m.id)
      .filter(Boolean)
      .sort();

    return NextResponse.json({ models });
  } catch (error: any) {
    console.error('[AI Models] Network error:', error.message);
    return NextResponse.json(
      { error: formatNetworkError(error) },
      { status: 500 }
    );
  }
}
