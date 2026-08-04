import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

/**
 * 深度分析回测落库
 * POST: 深度分析完成时 upsert 一条全局匿名 record（按 stockCode+entryDate+action 去重）
 * GET:  查某股某日的 record + T+N 回测（供 AnalysisHistory 展示）
 */

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      stockCode, stockName, entryDate, entryPrice, action,
      targetLow, targetHigh, stopLoss, position, confidence, reasoning,
      marketRegime,
    } = body;

    if (!stockCode || !entryDate || !action || typeof entryPrice !== 'number') {
      return NextResponse.json({ error: '缺少必要参数' }, { status: 400 });
    }

    const record = await prisma.deepAnalysisRecord.upsert({
      where: { stockCode_entryDate_action: { stockCode, entryDate, action } },
      create: {
        stockCode, stockName: stockName || stockCode,
        entryDate, entryPrice, action,
        targetLow: targetLow ?? null,
        targetHigh: targetHigh ?? null,
        stopLoss: stopLoss ?? null,
        position: position ?? null,
        confidence: confidence ?? null,
        marketRegime: marketRegime ?? null,
        reasoning: (reasoning || '').slice(0, 500) || null,
        createdAt: new Date().toISOString(),
      },
      update: {
        // 覆盖分析内容（保留 recordId，已算的 eval 不动；marketRegime 同日重跑以最新为准）
        stockName: stockName || stockCode,
        entryPrice,
        targetLow: targetLow ?? null,
        targetHigh: targetHigh ?? null,
        stopLoss: stopLoss ?? null,
        position: position ?? null,
        confidence: confidence ?? null,
        marketRegime: marketRegime ?? null,
        reasoning: (reasoning || '').slice(0, 500) || null,
      },
    });

    return NextResponse.json({ id: record.id });
  } catch (e: any) {
    console.error('[api/ai/deep-eval POST]', e);
    return NextResponse.json({ error: e.message || '落库失败' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const stockCode = searchParams.get('stockCode');
    const entryDate = searchParams.get('entryDate');

    if (!stockCode) {
      return NextResponse.json({ error: '缺少 stockCode' }, { status: 400 });
    }

    // 有 entryDate 查特定日；否则查该股所有（供胜率面板聚合）
    const where = entryDate
      ? { stockCode, entryDate }
      : { stockCode };
    const records = await prisma.deepAnalysisRecord.findMany({
      where,
      include: { evals: true },
      orderBy: { entryDate: 'desc' },
      take: entryDate ? 10 : 200,
    });

    return NextResponse.json({ records });
  } catch (e: any) {
    console.error('[api/ai/deep-eval GET]', e);
    return NextResponse.json({ error: e.message || '查询失败' }, { status: 500 });
  }
}
