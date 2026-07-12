/**
 * Stock code parser - normalizes stock codes between different providers.
 *
 * Input formats:
 *   - "sh600519" / "sz000001" / "bj430047"
 *   - "600519" (Shanghai) / "000001" (Shenzhen) / "430047" (Beijing)
 *
 * Output formats by provider:
 *   - Sina: "sh600519", "sz000001"
 *   - East Money: "1.600519" (SH), "0.000001" (SZ), "0.430047" (BJ)
 *   - Tencent: "sh600519", "sz000001"
 */

const SH_PREFIXES = ['60', '68'];      // Shanghai stocks
const SZ_PREFIXES = ['00', '30', '002', '003', '300', '301']; // Shenzhen stocks
const BJ_PREFIXES = ['4', '8', '43', '83', '87'];             // Beijing stocks

function detectMarket(code) {
  // Already has market prefix
  if (/^(sh|sz|bj)/i.test(code)) {
    return code.slice(0, 2).toLowerCase();
  }
  // Detect from numeric prefix
  const clean = code.replace(/\D/g, '');
  for (const p of SH_PREFIXES) {
    if (clean.startsWith(p)) return 'sh';
  }
  for (const p of BJ_PREFIXES) {
    if (clean.startsWith(p)) return 'bj';
  }
  for (const p of SZ_PREFIXES) {
    if (clean.startsWith(p)) return 'sz';
  }
  return 'sz'; // default
}

function toSina(code) {
  // Handle index codes with s_ prefix (e.g. s_sh000001 → sh000001)
  if (code.startsWith('s_')) {
    return code.slice(2);
  }
  const clean = code.replace(/\D/g, '');
  const market = detectMarket(code);
  return `${market}${clean}`;
}

function toEastMoney(code) {
  const clean = code.replace(/\D/g, '');
  const market = detectMarket(code);
  const marketCode = market === 'sh' ? '1' : '0';
  return `${marketCode}.${clean}`;
}

function toTencent(code) {
  // Tencent uses same format as Sina
  return toSina(code);
}

function splitCode(fullCode) {
  // "sh600519" -> { market: "sh", code: "600519" }
  const match = fullCode.match(/^(sh|sz|bj)(\d+)$/i);
  if (match) {
    return { market: match[1].toLowerCase(), code: match[2] };
  }
  const market = detectMarket(fullCode);
  const clean = fullCode.replace(/\D/g, '');
  return { market, code: clean };
}

module.exports = { detectMarket, toSina, toEastMoney, toTencent, splitCode };
