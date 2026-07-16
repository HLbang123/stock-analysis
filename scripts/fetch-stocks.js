// 获取全部A股列表，保存到 public/stocks.json
// 用法: node scripts/fetch-stocks.js
const fs = require('fs');
const path = require('path');

async function fetchAll() {
  let all = [];
  for (let p = 1; p <= 12; p++) {
    const url = `https://push2.eastmoney.com/api/qt/clist/get?pn=${p}&pz=500&np=1&fields=f12,f14&fid=f12&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23`;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      const d = await r.json();
      const items = (d.data?.diff || []).map(i => ({ c: i.f12, n: i.f14 }));
      if (items.length === 0) break;
      all = all.concat(items);
      console.log(`Page ${p}: ${items.length} items (total: ${all.length})`);
    } catch (e) {
      console.log(`Page ${p} failed: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  const outPath = path.join(__dirname, '..', 'public', 'stocks.json');
  fs.writeFileSync(outPath, JSON.stringify(all));
  console.log(`Done: ${all.length} stocks saved to ${outPath}`);
}

fetchAll();
