import { NextRequest, NextResponse } from 'next/server';

/**
 * 解码GBK编码的响应（腾讯/新浪API使用GBK编码中文）
 */
function decodeGBK(buffer: ArrayBuffer): string {
  try {
    const decoder = new TextDecoder('gbk');
    return decoder.decode(buffer);
  } catch {
    // 回退：尝试 gb18030 编码
    try {
      const decoder = new TextDecoder('gb18030');
      return decoder.decode(buffer);
    } catch {
      // 最后回退：UTF-8
      const decoder = new TextDecoder('utf-8');
      return decoder.decode(buffer);
    }
  }
}

/**
 * 实时行情代理 — 避免浏览器CORS限制
 * 优先腾讯，失败则回退新浪
 */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  if (!code) {
    return NextResponse.json({ error: '缺少 code 参数' }, { status: 400 });
  }

  // 解析代码
  let market = '';
  let pureCode = '';
  if (code.startsWith('sh') || code.startsWith('sz') || code.startsWith('bj')) {
    market = code.substring(0, 2);
    pureCode = code.substring(2);
  } else if (/^6\d{5}$/.test(code)) {
    market = 'sh';
    pureCode = code;
  } else if (/^(0|3)\d{5}$/.test(code)) {
    market = 'sz';
    pureCode = code;
  } else if (/^8\d{5}$/.test(code)) {
    market = 'bj';
    pureCode = code;
  } else {
    return NextResponse.json({ error: '无效的股票代码' }, { status: 400 });
  }

  const symbol = `${market}${pureCode}`;

  try {
    // 优先使用腾讯
    const quote = await fetchTencent(symbol);
    if (quote) return NextResponse.json(quote);

    // 回退新浪
    const sinaQuote = await fetchSina(symbol);
    if (sinaQuote) return NextResponse.json(sinaQuote);

    return NextResponse.json({ error: '获取行情失败' }, { status: 502 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

async function fetchTencent(symbol: string) {
  try {
    const market = symbol.substring(0, 2);
    const pureCode = symbol.substring(2);
    const res = await fetch(`https://qt.gtimg.cn/q=${market}${pureCode}`, {
      headers: { Referer: 'https://gu.qq.com' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;

    const text = decodeGBK(await res.arrayBuffer());
    // 格式: v_sh600519="1~贵州茅台~600519~1197.12~..."
    const match = text.match(/="([^"]+)"/);
    if (!match) return null;

    const data = match[1].split('~');
    if (data.length < 40) return null;

    const name = data[1];
    const price = parseFloat(data[3]);
    const preClose = parseFloat(data[4]);
    const open = parseFloat(data[5]);
    const high = parseFloat(data[33]);
    const low = parseFloat(data[34]);
    const volume = parseInt(data[36]) || 0;
    const amount = parseFloat(data[37]) || 0;

    if (isNaN(price) || price === 0) return null;

    return {
      code: symbol,
      name: name || symbol,
      price,
      preClose,
      change: price - preClose,
      changePercent: ((price - preClose) / preClose) * 100,
      high,
      low,
      open,
      volume,
      amount,
      updateTime: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

async function fetchSina(symbol: string) {
  try {
    const res = await fetch(`https://hq.sinajs.cn/list=${symbol}`, {
      headers: { Referer: 'https://finance.sina.com.cn' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;

    const text = decodeGBK(await res.arrayBuffer());
    const match = text.match(/="([^"]+)"/);
    if (!match) return null;

    const data = match[1].split(',');
    if (data.length < 32) return null;

    const name = data[0];
    const open = parseFloat(data[1]);
    const preClose = parseFloat(data[2]);
    const price = parseFloat(data[3]);
    const high = parseFloat(data[4]);
    const low = parseFloat(data[5]);
    const volume = parseInt(data[8]);
    const amount = parseFloat(data[9]);

    if (isNaN(price) || price === 0) return null;

    return {
      code: symbol,
      name: name || symbol,
      price,
      preClose,
      change: price - preClose,
      changePercent: ((price - preClose) / preClose) * 100,
      high,
      low,
      open,
      volume,
      amount,
      updateTime: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}
