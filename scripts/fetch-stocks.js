// 从 Tushare 获取全部A股列表，保存到 public/stocks.json
// 用法: node scripts/fetch-stocks.js
// 依赖: 项目根目录 .env.local 中须配置 TUSHARE_TOKEN
const fs = require('fs');
const path = require('path');

const TUSHARE_API = 'https://api.tushare.pro';

// 从 .env.local 读取 token
function loadToken() {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(envPath)) {
    console.error('❌ 未找到 .env.local，请先配置 TUSHARE_TOKEN');
    process.exit(1);
  }
  const content = fs.readFileSync(envPath, 'utf-8');
  const match = content.match(/TUSHARE_TOKEN=(.+)/);
  if (!match) {
    console.error('❌ .env.local 中未找到 TUSHARE_TOKEN');
    process.exit(1);
  }
  return match[1].trim();
}

async function callTushare(apiName, params = {}, fields = '') {
  const body = { api_name: apiName, token, params };
  if (fields) body.fields = fields;

  const res = await fetch(TUSHARE_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (json.code !== 0) {
    throw new Error(`Tushare ${apiName} 错误: ${json.msg || json.code}`);
  }
  return json;
}

const token = loadToken();

async function main() {
  const outPath = path.join(__dirname, '..', 'public', 'stocks.json');
  const allStocks = new Map();

  // ===== 1. A股股票（stock_basic）=====
  console.log('获取 A股列表...');
  try {
    const res = await callTushare('stock_basic',
      { list_status: 'L' },
      'ts_code,name,area,industry,list_date'
    );

    for (const item of res.data.items) {
      const ts_code = item[0];  // "000001.SZ"
      const name = item[1];
      const industry = item[3] || '';

      // 提取纯数字代码
      const pureCode = ts_code.replace(/\.(SZ|SH|BJ)$/i, '');
      if (/^\d{6}$/.test(pureCode)) {
        allStocks.set(pureCode, { n: name, industry });
      }
    }
    console.log(`  A股: ${allStocks.size} 只`);
  } catch (e) {
    console.error(`  A股失败: ${e.message}`);
  }

  // ===== 2. ETF（fund_basic）=====
  console.log('获取 ETF 列表...');
  try {
    const res = await callTushare('fund_basic',
      { market: 'E', status: 'L' },
      'ts_code,name,fund_type'
    );

    if (!res.data?.items || res.data.items.length === 0) {
      console.log(`  ETF: 无数据（可能是积分不足或接口不可用）`);
    } else {
      let etfAdded = 0;
      for (const item of res.data.items) {
        const ts_code = item[0];
        const name = item[1];
        const fundType = item[2] || '';

        const pureCode = ts_code.replace(/\.(SZ|SH|BJ)$/i, '');
        if (/^\d{6}$/.test(pureCode) && !allStocks.has(pureCode)) {
          const label = fundType ? `${name}(${fundType})` : name;
          allStocks.set(pureCode, { n: label, industry: 'ETF' });
          etfAdded++;
        }
      }
      console.log(`  ETF 新增: ${etfAdded} 只，总计: ${allStocks.size} 只`);
    }
  } catch (e) {
    console.error(`  ETF 失败: ${e.message}`);
  }

  // ===== 3. 保存 =====
  if (allStocks.size === 0) {
    console.error('❌ 未获取到任何股票数据');
    process.exit(1);
  }

  const result = Array.from(allStocks.entries())
    .map(([c, { n, industry }]) => ({ c, n: n.replace(/\s/g, ''), industry }))
    .sort((a, b) => a.c.localeCompare(b.c));

  fs.writeFileSync(outPath, JSON.stringify(result));
  console.log(`✅ 已保存 ${result.length} 只到 public/stocks.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
