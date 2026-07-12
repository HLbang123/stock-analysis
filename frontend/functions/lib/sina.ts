/**
 * Sina Finance real-time quote service for Cloudflare Workers.
 * Returns A-share real-time quotes (GBK-decoded).
 */

const SINA_FIELDS = {
  name: 0, open: 1, prevClose: 2, price: 3, high: 4, low: 5,
  volume: 8, amount: 9, date: 30, time: 31,
};

export async function fetchSinaQuotes(codes: string[]): Promise<any[]> {
  const { toSina, splitCode } = await import('../lib/utils');
  const sinaCodes = codes.map(c => toSina(c)).join(',');
  const url = `https://hq.sinajs.cn/list=${sinaCodes}`;

  const resp = await fetch(url, {
    headers: { Referer: 'https://finance.sina.com.cn' },
  });

  const buffer = await resp.arrayBuffer();
  // GBK decoding via TextDecoder
  const text = new TextDecoder('gbk').decode(buffer);
  return parseQuotes(text, codes);
}

function parseQuotes(text: string, originalCodes: string[]): any[] {
  const { splitCode } = { splitCode: (c: string) => {
    const match = c.match(/^(sh|sz|bj)(\d+)$/i);
    if (match) return { market: match[1].toLowerCase(), code: match[2] };
    const m = /^(sh|sz|bj)/i.test(c) ? c.slice(0, 2).toLowerCase() : 'sz';
    return { market: m, code: c.replace(/\D/g, '') };
  }};

  const results: any[] = [];
  const lines = text.trim().split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const match = line.match(/="(.+)"/);
    if (!match) continue;
    const fields = match[1].split(',');
    if (fields.length < 32) continue;

    const stockCode = originalCodes[i] || '';
    const { market, code } = splitCode(stockCode);
    const name = fields[0];

    const result = {
      code, market, fullCode: `${market}${code}`, name,
      open: parseFloat(fields[1]) || 0,
      prevClose: parseFloat(fields[2]) || 0,
      price: parseFloat(fields[3]) || 0,
      high: parseFloat(fields[4]) || 0,
      low: parseFloat(fields[5]) || 0,
      volume: parseFloat(fields[8]) || 0,
      amount: parseFloat(fields[9]) || 0,
      change: 0, changePercent: 0,
      date: fields[30] || '', time: fields[31] || '',
    };

    if (result.prevClose > 0) {
      result.change = +(result.price - result.prevClose).toFixed(2);
      result.changePercent = +((result.change / result.prevClose) * 100).toFixed(2);
    }
    results.push(result);
  }

  return results;
}
