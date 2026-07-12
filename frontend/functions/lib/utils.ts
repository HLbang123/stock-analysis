/**
 * Stock code parser — adapted for Cloudflare Workers.
 * Same logic as the Express backend, no Node.js dependencies.
 */

const SH_PREFIXES = ['60', '68'];
const SZ_PREFIXES = ['00', '30', '002', '003', '300', '301'];
const BJ_PREFIXES = ['4', '8', '43', '83', '87'];

export function detectMarket(code: string): string {
  if (/^(sh|sz|bj)/i.test(code)) return code.slice(0, 2).toLowerCase();
  const clean = code.replace(/\D/g, '');
  for (const p of SH_PREFIXES) if (clean.startsWith(p)) return 'sh';
  for (const p of BJ_PREFIXES) if (clean.startsWith(p)) return 'bj';
  for (const p of SZ_PREFIXES) if (clean.startsWith(p)) return 'sz';
  return 'sz';
}

export function toSina(code: string): string {
  if (code.startsWith('s_')) return code.slice(2);
  const clean = code.replace(/\D/g, '');
  return `${detectMarket(code)}${clean}`;
}

export function toEastMoney(code: string): string {
  const clean = code.replace(/\D/g, '');
  const m = detectMarket(code) === 'sh' ? '1' : '0';
  return `${m}.${clean}`;
}

export function toTencent(code: string): string {
  return toSina(code);
}

export function splitCode(fullCode: string) {
  const match = fullCode.match(/^(sh|sz|bj)(\d+)$/i);
  if (match) return { market: match[1].toLowerCase(), code: match[2] };
  const market = detectMarket(fullCode);
  return { market, code: fullCode.replace(/\D/g, '') };
}

// ====== Cache helper ======

/**
 * Set CDN + browser cache headers based on TTL (seconds).
 */
export function withCache(headers: Headers, ttlSeconds: number) {
  headers.set('Cache-Control', `public, max-age=${ttlSeconds}, s-maxage=${ttlSeconds}`);
}
