import { NextRequest, NextResponse } from 'next/server';
import { detectMarket } from '@/lib/identify';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/**
 * K线数据代理 — 避免浏览器CORS限制
 * 主源：腾讯K线（前复权 qfq, 稳定不限流, 成交量:手）
 * 备用：新浪公开API（前复权 fq=1, 成交量:股 → 归一化为手）
 * 输出统一归一化：成交量单位为手(百股)，价格前复权
 */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  const days = parseInt(request.nextUrl.searchParams.get('days') || '120');
  const scale = parseInt(request.nextUrl.searchParams.get('scale') || '240');

  if (!code) {
    return NextResponse.json({ error: '缺少 code 参数' }, { status: 400 });
  }

  try {
    // 优先腾讯K线 (前复权 qfq, 稳定)
    const klines = await fetchTencentKLine(code, days);
    if (klines && klines.length > 0) return NextResponse.json(klines);

    // 回退新浪公开API (前复权 fq=1)
    const sinaKLines = await fetchSinaKLine(code, scale, days);
    if (sinaKLines && sinaKLines.length > 0) return NextResponse.json(sinaKLines);

    return NextResponse.json([], { status: 200 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * 腾讯K线API — 前复权 qfq
 * 成交量原始单位为手，无需转换
 */
async function fetchTencentKLine(code: string, days: number) {
  try {
    let market = 'sh';
    let pureCode = code;
    if (code.startsWith('sh') || code.startsWith('sz') || code.startsWith('bj')) {
      market = code.substring(0, 2);
      pureCode = code.substring(2);
    } else {
      const detected = detectMarket(code);
      if (detected) {
        market = detected;
        pureCode = code;
      }
    }

    const url = `http://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${market}${pureCode},day,,,${days},qfq`;
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://finance.qq.com' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;

    const json = await res.json();
    const stockKey = `${market}${pureCode}`;
    const dayData = json.data?.[stockKey]?.day || json.data?.[stockKey]?.qfqday;

    if (!dayData || !Array.isArray(dayData)) return null;

    return dayData.map((item: string[]) => {
      const rawDate = String(item[0]);
      const cleaned = rawDate.replace(/-/g, '');
      const date = cleaned.length >= 8
        ? `${cleaned.slice(0, 4)}-${cleaned.slice(4, 6)}-${cleaned.slice(6, 8)}`
        : rawDate;
      return {
        date,
        open: parseFloat(item[1]),
        close: parseFloat(item[2]),
        high: parseFloat(item[3]),
        low: parseFloat(item[4]),
        volume: parseInt(item[5]) || 0,
      };
    });
  } catch {
    return null;
  }
}

/**
 * 新浪公开K线API — 前复权 fq=1，标准JSON格式
 * 成交量原始单位为股，归一化为手（÷100）
 */
async function fetchSinaKLine(code: string, scale: number, days: number) {
  try {
    const res = await fetch(
      `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${code}&scale=${scale}&ma=no&datalen=${days}&fq=1`,
      {
        headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn' },
        signal: AbortSignal.timeout(15000),
      }
    );
    if (!res.ok) return null;

    const json = await res.json();
    if (!Array.isArray(json) || json.length === 0) return null;

    return json.map((item: any) => ({
      date: item.day,
      open: parseFloat(item.open),
      close: parseFloat(item.close),
      high: parseFloat(item.high),
      low: parseFloat(item.low),
      // 成交量归一化：股 → 手（÷100）
      volume: Math.round(parseInt(item.volume) / 100) || 0,
    }));
  } catch {
    return null;
  }
}
