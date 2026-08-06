import { NextRequest, NextResponse } from 'next/server';
import { buildCalibrationNote } from '@/services/deep-analysis/calibration';

/**
 * GET /api/ai/calibration?stockCode=xxxxx — 深度分析裁决校准注记
 *
 * 深度分析浏览器直连后，原本服务器 route 内部拼的"历史回测胜率校准"文本
 * 需要单独暴露给前端（数据在 DB，只有服务器能查）。内部有 10 分钟内存缓存。
 * 返回 { note }，失败返回 { note: '' }（调用方 filter 掉，不阻断分析）。
 */
export async function GET(request: NextRequest) {
  const stockCode = request.nextUrl.searchParams.get('stockCode') || undefined;
  const note = await buildCalibrationNote(stockCode);
  return NextResponse.json({ note });
}
