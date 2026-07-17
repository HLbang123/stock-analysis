// 获取全部A股ETF列表，合并到 public/stocks.json
// 用法: node scripts/fetch-etfs.js
const fs = require('fs');
const path = require('path');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Referer': 'https://quote.eastmoney.com/center/gridlist.html#fund_etf',
};

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function loadStocks(filePath) {
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }
  return [];
}

function saveMerged(filePath, etfsMap) {
  const stocks = loadStocks(filePath);
  const existing = new Set(stocks.map(s => s.c));
  const newEtfs = Array.from(etfsMap.entries())
    .filter(([c]) => !existing.has(c))
    .map(([c, n]) => ({ c, n }));
  if (newEtfs.length > 0) {
    const merged = [...stocks, ...newEtfs].sort((a, b) => a.c.localeCompare(b.c));
    fs.writeFileSync(filePath, JSON.stringify(merged));
  }
  return newEtfs.length;
}

async function main() {
  const outPath = path.join(__dirname, '..', 'public', 'stocks.json');
  const PAGE_SIZE = 100;
  const MAX_PAGES = 15;
  const allEtfs = new Map();

  const initialCount = loadStocks(outPath).length;
  console.log(`现有: ${initialCount} 只`);

  console.log('等待 30 秒...');
  await sleep(30000);

  let totalNew = 0;

  for (let p = 1; p <= MAX_PAGES; p++) {
    const params = new URLSearchParams({
      pn: String(p), pz: String(PAGE_SIZE), po: '1', np: '1',
      ut: 'bd1d9ddb04089700cf9c27f6f7426281',
      fltt: '2', invt: '2',
      wbp2u: '|0|0|0|web',
      fid: 'f3',
      fs: 'b:MK0021,b:MK0022,b:MK0023,b:MK0024',
      fields: 'f12,f14',
    });
    const url = `https://push2delay.eastmoney.com/api/qt/clist/get?${params}`;

    let data;
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
      if (!res.ok) {
        console.log(`p${p}: HTTP ${res.status}，跳过`);
        break;
      }
      data = await res.json();
    } catch (e) {
      console.log(`p${p}: err ${e.message}，跳过`);
      break;
    }

    const items = data?.data?.diff || [];
    if (items.length === 0) break;

    for (const it of items) {
      const code = it.f12;
      if (/^\d{6}$/.test(code)) allEtfs.set(code, it.f14.replace(/\s/g, ''));
    }

    // 每页成功后增量写入
    const added = saveMerged(outPath, allEtfs);
    totalNew += added;
    const current = loadStocks(outPath).length;
    process.stdout.write(`p${p}:${items.length} +${added} =${current} `);

    if (items.length < PAGE_SIZE) break;
    if (p < MAX_PAGES) {
      console.log(''); // 换行
      await sleep(60000);
    }
  }

  console.log(`\n完成: ${loadStocks(outPath).length} 只（新增 ${totalNew} 只 ETF）`);
}

main().catch(e => { console.error(e); process.exit(1); });
