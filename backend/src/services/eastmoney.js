const axios = require('axios');
const { toEastMoney } = require('../utils/codeParser');
const config = require('../config');

/**
 * Fetch K-line data from East Money.
 *
 * Period mapping:
 *   daily=101, weekly=102, monthly=103, 30min=30, 60min=60, 15min=15, 5min=5
 *
 * Adjusted:
 *   fqt=1 (前复权 forward-adjusted), fqt=0 (不复权)
 *
 * K-line response fields (comma-delimited):
 *   date, open, close, high, low, volume, amount, amplitude, change%, change, turnover%
 */

const PERIOD_MAP = {
  daily: 101,
  weekly: 102,
  monthly: 103,
  '30min': 30,
  '60min': 60,
  '15min': 15,
  '5min': 5,
};

async function getKline(code, period = 'daily', limit = 300, adjusted = 1) {
  const secid = toEastMoney(code);
  const klt = PERIOD_MAP[period] || 101;
  const fqt = adjusted ? 1 : 0;

  const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get';
  const params = {
    secid: secid,
    fields1: 'f1,f2,f3,f4,f5,f6',
    fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61',
    klt: klt,
    fqt: fqt,
    end: '20500101',
    lmt: limit,
  };

  const response = await axios.get(url, {
    params,
    timeout: config.API_TIMEOUT,
  });

  const data = response.data;
  if (!data || data.rc !== 0 || !data.data) {
    throw new Error(`East Money API error: ${JSON.stringify(data)}`);
  }

  return parseKline(data.data, code);
}

function parseKline(data, originalCode) {
  const name = data.name || '';
  const code = data.code || originalCode;
  const klines = (data.klines || []).map(line => {
    // Format: "date,open,close,high,low,volume,amount,amplitude,change%,change,turnover%"
    const parts = line.split(',');
    return {
      date: parts[0],
      open: parseFloat(parts[1]),
      close: parseFloat(parts[2]),
      high: parseFloat(parts[3]),
      low: parseFloat(parts[4]),
      volume: parseFloat(parts[5]),    // 手
      amount: parseFloat(parts[6]),     // 元
    };
  });

  return { code, name, klines };
}

module.exports = { getKline };
