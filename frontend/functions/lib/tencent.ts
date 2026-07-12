/**
 * Tencent Finance fallback quote service for Cloudflare Workers.
 */

export async function fetchTencentQuotes(codes: string[]): Promise<any[]> {
  const { toTencent, splitCode } = await import('../lib/utils');
  const tCodes = codes.map(c => toTencent(c)).join(',');
  const url = `https://qt.gtimg.cn/q=${tCodes}`;

  const resp = await fetch(url);
  const text = await resp.text();
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
    const fields = match[1].split('~');
    if (fields.length < 10) continue;

    const { market, code } = splitCode(originalCodes[i] || fields[2] || '');
    const result = {
      code, market, fullCode: `${market}${code}`,
      name: fields[1] || '',
      price: parseFloat(fields[3]) || 0,
      prevClose: parseFloat(fields[4]) || 0,
      open: parseFloat(fields[5]) || 0,
      volume: parseFloat(fields[6]) || 0,
      high: parseFloat(fields[33]) || 0,
      low: parseFloat(fields[34]) || 0,
      amount: parseFloat(fields[37]) || 0,
      change: 0, changePercent: 0,
    };

    if (result.prevClose > 0) {
      result.change = +(result.price - result.prevClose).toFixed(2);
      result.changePercent = +((result.change / result.prevClose) * 100).toFixed(2);
    }
    results.push(result);
  }

  return results;
}
