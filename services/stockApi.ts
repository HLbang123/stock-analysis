import { RealtimeQuote, KLineData } from '@/types';

/**
 * 新浪财经实时行情 API
 * 格式: var hq_str_sh600519="贵州茅台,1765.00,1760.00,1762.50,1770.00,1755.00,..."
 */
export async function getRealtimeSina(code: string): Promise<RealtimeQuote | null> {
  try {
    const market = code.startsWith('sh') || code.startsWith('sz') || code.startsWith('bj')
      ? code.substring(0, 2)
      : (code.match(/^[0-9]/) && code.length === 6 ? (code[0] === '6' ? 'sh' : 'sz') : 'sh');

    const pureCode = market.length === 2 ? code.substring(2) : code;
    const symbol = `${market}${pureCode}`;

    const response = await fetch(`https://hq.sinajs.cn/list=${symbol}`, {
      headers: { Referer: 'https://finance.sina.com.cn' }
    });

    if (!response.ok) return null;

    const text = await response.text();
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

    const change = price - preClose;
    const changePercent = (change / preClose) * 100;

    return {
      code: symbol,
      name: name || symbol,
      price,
      preClose,
      change,
      changePercent,
      high,
      low,
      open,
      volume,
      amount,
      updateTime: new Date().toISOString()
    };
  } catch (error) {
    console.error('新浪行情获取失败:', error);
    return null;
  }
}

/**
 * 腾讯财经实时行情 API (备用)
 */
export async function getRealtimeTencent(code: string): Promise<RealtimeQuote | null> {
  try {
    const marketMap: Record<string, string> = { sh: 'sh', sz: 'sz', bj: 'bj' };
    const market = code.startsWith('sh') || code.startsWith('sz') || code.startsWith('bj')
      ? code.substring(0, 2)
      : (code[0] === '6' ? 'sh' : 'sz');

    const pureCode = market.length === 2 ? code.substring(2) : code;
    const symbol = `${market}${pureCode}`;
    const tencentMarket = marketMap[market] || 'sh';

    const response = await fetch(`https://qt.gtimg.cn/q=${tencentMarket}${pureCode}`, {
      headers: { Referer: 'https://gu.qq.com' }
    });

    if (!response.ok) return null;

    const text = await response.text();
    const match = text.match(/~([^~]+)~/);
    if (!match) return null;

    const data = match[1].split('~');
    if (data.length < 40) return null;

    const name = data[1];
    const price = parseFloat(data[3]);
    const preClose = parseFloat(data[4]);
    const open = parseFloat(data[5]);
    const high = parseFloat(data[33]);
    const low = parseFloat(data[34]);
    const volume = parseInt(data[36]) * 100; // 腾讯返回的是手
    const amount = parseFloat(data[37]) * 1000;

    if (isNaN(price) || price === 0) return null;

    const change = price - preClose;
    const changePercent = (change / preClose) * 100;

    return {
      code: symbol,
      name: name || symbol,
      price,
      preClose,
      change,
      changePercent,
      high,
      low,
      open,
      volume,
      amount,
      updateTime: new Date().toISOString()
    };
  } catch (error) {
    console.error('腾讯行情获取失败:', error);
    return null;
  }
}

/**
 * 获取实时行情（优先新浪，失败则尝试腾讯）
 */
export async function getRealtimeQuote(code: string): Promise<RealtimeQuote | null> {
  let quote = await getRealtimeSina(code);
  if (!quote) {
    quote = await getRealtimeTencent(code);
  }
  return quote;
}

/**
 * 新浪历史K线数据
 * scale: 240=日K, 60=60分钟, 30=30分钟, 15=15分钟, 5=5分钟
 */
export async function getKLineSina(
  symbol: string,
  scale: number = 240,
  dataLen: number = 120
): Promise<KLineData[]> {
  try {
    // 转换符号格式: sh600519 -> sh600519
    const market = symbol.substring(0, 2);
    const code = symbol.substring(2);

    const response = await fetch(
      `https://finance.sina.com.cn/realstock/company/${market}${code}/hisdata.shtml?${scale}=${dataLen}`,
      { headers: { Referer: 'https://finance.sina.com.cn' } }
    );

    if (!response.ok) throw new Error('请求失败');

    const text = await response.text();
    const dataMatch = text.match(/\[{[^}]+\}\]/);
    if (!dataMatch) return [];

    const jsonStr = dataMatch[0];
    const items = JSON.parse(jsonStr);

    return items.map((item: any) => ({
      date: item.date,
      open: parseFloat(item.open),
      high: parseFloat(item.high),
      low: parseFloat(item.low),
      close: parseFloat(item.close),
      volume: parseInt(item.volume)
    })).reverse();
  } catch (error) {
    console.error('新浪K线获取失败:', error);
    return [];
  }
}

/**
 * 股票搜索（批量获取实时行情）
 */
export async function searchStocks(query: string): Promise<RealtimeQuote[]> {
  try {
    const codes = query.split(/[,，\s]+/).filter(c => c.length > 0);
    if (codes.length === 0) return [];

    const results = await Promise.all(
      codes.map(code => getRealtimeQuote(code))
    );

    return results.filter((r): r is RealtimeQuote => r !== null);
  } catch (error) {
    console.error('股票搜索失败:', error);
    return [];
  }
}

/**
 * 解析股票代码输入
 */
export function parseStockCode(input: string): { market: string; pureCode: string; fullCode: string } {
  const trimmed = input.trim().toLowerCase();
  let market = 'sh';
  let pureCode = trimmed;

  if (trimmed.startsWith('sh')) {
    market = 'sh';
    pureCode = trimmed.substring(2);
  } else if (trimmed.startsWith('sz')) {
    market = 'sz';
    pureCode = trimmed.substring(2);
  } else if (trimmed.startsWith('bj')) {
    market = 'bj';
    pureCode = trimmed.substring(2);
  } else if (/^6\d{5}$/.test(trimmed)) {
    market = 'sh';
    pureCode = trimmed;
  } else if (/^(0|3)\d{5}$/.test(trimmed)) {
    market = 'sz';
    pureCode = trimmed;
  } else if (/^8\d{5}$/.test(trimmed)) {
    market = 'bj';
    pureCode = trimmed;
  }

  return { market, pureCode, fullCode: `${market}${pureCode}` };
}