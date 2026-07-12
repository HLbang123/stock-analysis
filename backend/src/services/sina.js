const axios = require('axios');
const iconv = require('iconv-lite');
const { toSina, splitCode } = require('../utils/codeParser');
const config = require('../config');

/**
 * Fetch real-time quotes from Sina Finance.
 * Sina returns GBK-encoded text with comma-delimited fields.
 *
 * Field reference (33 fields total):
 *   0: name, 1: open, 2: prevClose, 3: price, 4: high, 5: low,
 *   6: buyPrice, 7: sellPrice, 8: volume(手), 9: amount(万),
 *   10-14: bid volumes, 15-19: bid prices,
 *   20-24: ask prices, 25-29: ask volumes,
 *   30: date, 31: time, 32: status
 */
async function getQuotes(codes) {
  const sinaCodes = codes.map(c => toSina(c)).join(',');
  const url = `https://hq.sinajs.cn/list=${sinaCodes}`;

  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: config.API_TIMEOUT,
    headers: {
      Referer: 'https://finance.sina.com.cn',
    },
  });

  const text = iconv.decode(Buffer.from(response.data), 'GBK');
  return parseQuotes(text, codes);
}

function parseQuotes(text, originalCodes) {
  const results = [];
  const lines = text.trim().split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Extract the part after the first quote mark
    const match = line.match(/="(.+)"/);
    if (!match) continue;

    const fields = match[1].split(',');
    if (fields.length < 32) continue;

    const { market, code } = splitCode(originalCodes[i] || '');
    const name = fields[0];

    results.push({
      code,
      market,
      fullCode: `${market}${code}`,
      name,
      open: parseFloat(fields[1]) || 0,
      prevClose: parseFloat(fields[2]) || 0,
      price: parseFloat(fields[3]) || 0,
      high: parseFloat(fields[4]) || 0,
      low: parseFloat(fields[5]) || 0,
      volume: parseFloat(fields[8]) || 0,       // 手
      amount: parseFloat(fields[9]) || 0,        // 万元
      change: 0,
      changePercent: 0,
      date: fields[30] || '',
      time: fields[31] || '',
    });
  }

  // Calculate change
  for (const q of results) {
    if (q.prevClose > 0) {
      q.change = +(q.price - q.prevClose).toFixed(2);
      q.changePercent = +((q.change / q.prevClose) * 100).toFixed(2);
    }
  }

  return results;
}

module.exports = { getQuotes };
