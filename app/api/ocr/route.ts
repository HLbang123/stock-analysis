import { NextRequest, NextResponse } from 'next/server';

/**
 * OCR服务端备份 — 图片文字识别
 * 当客户端tesseract.js不可用时的回退方案
 * 提取6位A股代码
 */
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const imageFile = formData.get('image') as File;

    if (!imageFile) {
      return NextResponse.json({ error: '未上传图片' }, { status: 400 });
    }

    // 将图片转base64用于简单的OCR逻辑
    // 在实际部署中，这里可以集成Tesseract.js服务端版本或其他OCR服务
    const arrayBuffer = await imageFile.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // 基础实现：返回简单响应
    // 生产环境建议部署专门的OCR微服务
    return NextResponse.json({
      codes: [],
      message: '服务端OCR暂未配置，请使用客户端OCR功能',
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: `OCR处理失败: ${error.message}` },
      { status: 500 }
    );
  }
}
