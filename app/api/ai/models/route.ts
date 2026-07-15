import { NextRequest, NextResponse } from 'next/server';

/**
 * 代理获取模型列表
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { baseUrl, apiKey } = body;

    if (!baseUrl) {
      return NextResponse.json({ error: '缺少 baseUrl' }, { status: 400 });
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
      return NextResponse.json(
        { error: `获取模型列表失败 (${response.status})` },
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
    return NextResponse.json(
      { error: `请求失败: ${error.message}` },
      { status: 500 }
    );
  }
}
