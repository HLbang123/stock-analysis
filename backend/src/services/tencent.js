const axios = require('axios');
const { toTencent, splitCode } = require('../utils/codeParser');
const config = require('../config');

/**
 * Fallback quote service using Tencent Finance.
 * Tencent returns UTF-8 text with a simpler format.
 *
 * Field reference (var key="..." prefix):
 *   name, code, price, prevClose, open, volume(手), bidPrice, askPrice,
 *   bidVol, askVol, high, low, ...more fields
 */
async function getQuotes(codes) {
  const tCodes = codes.map(c => toTencent(c)).join(',');
  const url = `https://qt.gtimg.cn/q=${tCodes}`;

  const response = await axios.get(url, {
    responseType: 'text',
    timeout: config.API_TIMEOUT,
  });

  return parseQuotes(response.data, codes);
}

function parseQuotes(text, originalCodes) {
  const results = [];
  const lines = text.trim().split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Extract field values between ~ delimiters after the key
    const match = line.match(/="(.+)"/);
    if (!match) continue;

    const fields = match[1].split('~');
    if (fields.length < 10) continue;

    const { market, code } = splitCode(originalCodes[i] || fields[2] || '');

    results.push({
      code,
      market,
      fullCode: `${market}${code}`,
      name: fields[1] || '',
      price: parseFloat(fields[3]) || 0,
      prevClose: parseFloat(fields[4]) || 0,
      open: parseFloat(fields[5]) || 0,
      volume: parseFloat(fields[6]) || 0,
      high: parseFloat(fields[33]) || 0,
      low: parseFloat(fields[34]) || 0,
      amount: parseFloat(fields[37]) || 0,
      change: 0,
      changePercent: 0,
    });
  }

  for (const q of results) {
    if (q.prevClose > 0) {
      q.change = +(q.price - q.prevClose).toFixed(2);
      q.changePercent = +((q.change / q.prevClose) * 100).toFixed(2);
    }
  }

  return results;
}

module.exports = { getQuotes };
