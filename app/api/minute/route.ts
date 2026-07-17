import { NextRequest, NextResponse } from 'next/server';
import { detectMarket } from '@/lib/identify';

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  if (!code) {
    return NextResponse.json({ error: '缺少 code 参数' }, { status: 400 });
  }

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

  console.log(`[minute] Fetching for ${market}${pureCode}`);

  // 方案1: 腾讯分钟线
  try {
    const points = await tryTencentMinuteOnline(market, pureCode);
    if (points && points.length > 0) {
      console.log(`[minute] ✅ Tencent minute: ${points.length} points`);
      return NextResponse.json(points);
    }
    console.log('[minute] Tencent minute: 无数据');
  } catch (e: any) {
    console.log(`[minute] Tencent minute error: ${e.message}`);
  }

  // 方案2: 5分钟K线
  try {
    const points = await tryM5KLine(market, pureCode);
    if (points && points.length > 0) {
      console.log(`[minute] ✅ M5 K-line: ${points.length} points`);
      return NextResponse.json(points);
    }
    console.log('[minute] M5 K-line: 无数据');
  } catch (e: any) {
    console.log(`[minute] M5 K-line error: ${e.message}`);
  }

  console.log('[minute] ❌ 所有数据源均无数据');
  return NextResponse.json([]);
}

async function tryTencentMinuteOnline(market: string, pureCode: string) {
  const symbol = `${market}${pureCode}`;
  // 只试 HTTP（腾讯分钟线API通常只支持HTTP）
  const url = `http://ifzq.gtimg.cn/appstock/app/minute/query?_var=min_data&code=${symbol}`;
  console.log(`[minute] Trying: ${url}`);

  const res = await fetch(url, {
    headers: { Referer: 'https://gu.qq.com' },
    signal: AbortSignal.timeout(10000),
  });

  console.log(`[minute] Tencent HTTP status: ${res.status}`);
  if (!res.ok) return null;

  const text = await res.text();
  console.log(`[minute] Response length: ${text.length}, first 100: ${text.slice(0, 100)}`);

  const startIdx = text.indexOf('min_data=');
  if (startIdx === -1) {
    console.log('[minute] min_data= not found');
    return null;
  }
  // 兼容 min_data=(...) 和 min_data={...} 两种格式
  let jsonStart = startIdx + 9; // "min_data=".length
  if (text[jsonStart] === '(') jsonStart++;
  let depth = 0, jsonEnd = jsonStart;
  for (let i = jsonStart; i < text.length; i++) {
    if (text[i] === '{' || text[i] === '[') depth++;
    else if (text[i] === '}' || text[i] === ']') depth--;
    if (depth === 0) { jsonEnd = i + 1; break; }
  }

  const data = JSON.parse(text.slice(jsonStart, jsonEnd));
  console.log(`[minute] JSON keys: ${Object.keys(data).join(', ')}`);
  console.log(`[minute] data keys: ${Object.keys(data?.data || {}).join(', ')}`);

  const stockData = data?.data;
  if (!stockData) return null;

  const pCode = pureCode;
  for (const key of Object.keys(stockData)) {
    const inner = stockData[key]?.data?.data;
    console.log(`[minute] key=${key}, hasData=${!!inner}, isArray=${Array.isArray(inner)}, length=${inner?.length || 0}`);
    if (Array.isArray(inner) && inner.length > 0) {
      return inner.map((item: string) => {
        const parts = String(item).split(' ');
        return {
          time: parts[0],
          price: parseFloat(parts[1]) || 0,
          volume: parseInt(parts[2]) || 0,
          avgPrice: parseFloat(parts[1]) || 0,
        };
      });
    }
  }
  return null;
}

async function tryM5KLine(market: string, pureCode: string) {
  const param = `${market}${pureCode},m5,,,48,qfq`;
  const url = `http://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${param}`;
  console.log(`[minute] Trying M5: ${url}`);

  const res = await fetch(url, {
    headers: { Referer: 'https://gu.qq.com' },
    signal: AbortSignal.timeout(10000),
  });

  console.log(`[minute] M5 HTTP status: ${res.status}`);
  if (!res.ok) return null;

  const json = await res.json();
  const key = `${market}${pureCode}`;
  const dataKeys = Object.keys(json?.data || {});
  console.log(`[minute] M5 data keys: ${dataKeys.join(', ')}`);

  const m5Data = json.data?.[key]?.m5 || json.data?.[key]?.qfqm5;
  // 调试：查看 data[key] 内部有哪些字段
  const innerKeys = Object.keys(json.data?.[key] || {});
  console.log(`[minute] M5 key=${key}, inner keys: ${innerKeys.join(', ')}, m5 found=${!!m5Data}, length=${m5Data?.length || 0}`);

  if (!Array.isArray(m5Data) || m5Data.length === 0) return null;

  return m5Data.map((item: any) => {
    const ts = String(Array.isArray(item) ? item[0] : item);
    const time = ts.length >= 12 ? ts.slice(8, 12) : ts.slice(-4);
    const close = parseFloat(Array.isArray(item) ? (item[2] || 0) : (item.close || 0));
    return {
      time: time.padStart(4, '0'),
      price: close || 0,
      volume: Array.isArray(item) ? (parseInt(item[5]) || 0) : (parseInt(item.volume) || 0),
      avgPrice: close || 0,
    };
  });
}
