import { NextRequest, NextResponse } from 'next/server';
import { normalizeMarketCode } from '@/lib/api-helpers';
import { getQuotesBatch } from '@/lib/server-quote-cache';
import { clientIp, rateLimit } from '@/lib/rate-limit';

const MAX_CODES = 500; // 400+ 自选一次拉全；URL 约 5KB，低于 nginx 8KB 上限

/**
 * 批量实时行情 — GET /api/quotes?codes=sh600519,sz000001,...
 * 响应 { quotes: { [code]: RealtimeQuote } }，缺失的代码不出现于映射（按失败处理）。
 * 服务端 5s 缓存 + 腾讯多代码单请求主路，上游压力与用户数解耦。
 */
export async function GET(request: NextRequest) {
  if (!rateLimit(`quotes:${clientIp(request)}`, 60, 60_000)) {
    return NextResponse.json({ error: '请求过于频繁' }, { status: 429 });
  }
  const raw = (request.nextUrl.searchParams.get('codes') || '').split(',');
  const symbols = [...new Set(
    raw.map((c) => c.trim().toLowerCase()).filter(Boolean).slice(0, MAX_CODES)
      .map((c) => {
        const parsed = normalizeMarketCode(c);
        return parsed ? `${parsed.market}${parsed.pureCode}` : null;
      })
      .filter((s): s is string => !!s)
  )];
  if (symbols.length === 0) {
    return NextResponse.json({ error: '缺少有效 codes 参数' }, { status: 400 });
  }

  const map = await getQuotesBatch(symbols);
  return NextResponse.json({ quotes: Object.fromEntries(map) });
}
