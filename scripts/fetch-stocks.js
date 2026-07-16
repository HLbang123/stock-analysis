// 获取全部A股列表，保存到 public/stocks.json
// 用法: node scripts/fetch-stocks.js
const fs = require('fs');
const path = require('path');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Referer': 'https://finance.sina.com.cn/',
};

async function fetchBoard(node, maxPages) {
  const all = new Map();
  for (let p = 1; p <= maxPages; p++) {
    const url = `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=${p}&num=100&sort=symbol&asc=1&node=${node}`;
    let items = [];
    try {
      const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
      const text = await r.text();
      items = text.startsWith('[') ? JSON.parse(text) : [];
      for (const it of items) {
        const code = String(it.symbol || '').replace(/^(sh|sz|bj)/i, '');
        if (/^\d{6}$/.test(code)) all.set(code, it.name);
      }
      process.stdout.write(`p${p}:${items.length} `);
    } catch (e) {
      process.stdout.write(`p${p}:err `);
      break;
    }
    if (items.length < 100) break;
    await new Promise(r => setTimeout(r, 10000));
  }
  return all;
}

async function main() {
  const outPath = path.join(__dirname, '..', 'public', 'stocks.json');

  console.log('沪市...');
  const sh = await fetchBoard('sh_a', 25);
  console.log(`= ${sh.size}`);

  // 先保存沪市，防止中断丢失
  const shArr = Array.from(sh.entries()).map(([c, n]) => ({ c, n }));
  fs.writeFileSync(outPath, JSON.stringify(shArr));
  console.log(`已保存 ${shArr.length} 只 (仅沪市)，继续抓深市...`);

  console.log('等60秒...');
  await new Promise(r => setTimeout(r, 60000));

  console.log('深市...');
  const sz = await fetchBoard('sz_a', 30);
  console.log(`= ${sz.size}`);

  const merged = new Map([...sh, ...sz]);
  const result = Array.from(merged.entries()).map(([c, n]) => ({ c, n }));
  fs.writeFileSync(outPath, JSON.stringify(result));
  console.log(`\n总计: ${result.length} 只股票`);
}

main();
