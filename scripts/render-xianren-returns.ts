/**
 * 仙人指路 · 收益结构信息图（读落盘 → 生成 SVG → 渲染 PNG）
 *
 * 数字全部由 .tmp/xr-path.json 现算，保证与 report-xianren-returns.ts 一致。
 * 输出：.tmp/xianren-returns.png（深色信息图，适合直接发飞书）
 *
 * 用法：npx tsx scripts/render-xianren-returns.ts --file=.tmp/xr-path.json --out=.tmp/xianren-returns.png
 */

import { readFileSync, writeFileSync } from 'fs';
import sharp from 'sharp';

interface Path { o: number; c: number; h: number; l: number }
interface Row { code: string; date: string; year: string; fwd?: Path[] }

const FONT = "'Microsoft YaHei','Segoe UI',sans-serif";
const C = {
  bg: '#0b1220', panel: '#121b2c', panelAlt: '#0f1829', border: '#22304a',
  text: '#e6edf7', dim: '#93a4bf', faint: '#64748b',
  blue: '#4cc2ff', green: '#34d399', red: '#f87171', amber: '#fbbf24', purple: '#a78bfa',
};

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const median = (a: number[]) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pctOf = (a: number[], f: (x: number) => boolean) => (a.length ? (a.filter(f).length / a.length) * 100 : 0);
const q = (a: number[], p: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const sg = (n: number, d = 2) => `${n >= 0 ? '+' : ''}${n.toFixed(d)}`;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function main(): void {
  const args = process.argv.slice(2);
  const file = (args.find((a) => a.startsWith('--file=')) ?? '--file=.tmp/xr-path.json').slice(7);
  const out = (args.find((a) => a.startsWith('--out=')) ?? '--out=.tmp/xianren-returns.png').slice(6);
  const rows = (JSON.parse(readFileSync(file, 'utf8')) as { rows: Row[] }).rows.filter((r) => r.fwd?.length === 5);

  // ---------- 指标 ----------
  const t1High = rows.map((r) => r.fwd![0].h);
  const t1Low = rows.map((r) => r.fwd![0].l);
  const t1Close = rows.map((r) => r.fwd![0].c);
  const t5Close = rows.map((r) => r.fwd![4].c);
  const t5Max = rows.map((r) => Math.max(...r.fwd!.map((d) => d.h)));
  const t1Open = rows.map((r) => r.fwd![0].o);
  const worst5 = rows.map((r) => Math.min(...r.fwd!.map((d) => d.l)));
  const sumClose5 = rows.map((r) => {
    let prev = 0, s = 0;
    for (const d of r.fwd!) { s += ((d.c - prev) / (100 + prev)) * 100; prev = d.c; }
    return s;
  });

  const W = 1240, PAD = 44, CW = W - PAD * 2;
  let y = 0;
  const out2: string[] = [];

  const text = (x: number, yy: number, s: string, opt: {
    size?: number; fill?: string; weight?: string; anchor?: string; opacity?: number; spacing?: number;
  } = {}) => {
    out2.push(`<text x="${x}" y="${yy}" font-family="${FONT}" font-size="${opt.size ?? 16}" fill="${opt.fill ?? C.text}"` +
      `${opt.weight ? ` font-weight="${opt.weight}"` : ''}${opt.anchor ? ` text-anchor="${opt.anchor}"` : ''}` +
      `${opt.opacity ? ` opacity="${opt.opacity}"` : ''}${opt.spacing ? ` letter-spacing="${opt.spacing}"` : ''}>${esc(s)}</text>`);
  };
  const rect = (x: number, yy: number, w: number, h: number, fill: string, r = 10, stroke?: string, sw = 1) => {
    out2.push(`<rect x="${x}" y="${yy}" width="${w}" height="${h}" rx="${r}" fill="${fill}"` +
      `${stroke ? ` stroke="${stroke}" stroke-width="${sw}"` : ''}/>`);
  };

  // ---------- 头部 ----------
  y = PAD + 10;
  text(PAD, y + 30, '仙人指路 · 收益结构', { size: 34, weight: '700' });
  text(PAD, y + 62, `样本 ${rows.length.toLocaleString()} 个信号 ｜ 2022-01 ~ 2026-09 ｜ 已剔除 924 行情 ｜ 沪深主板非 ST`, { size: 15, fill: C.dim });
  text(PAD, y + 88, '买点 = 确认日收盘（尾盘扫描可近似成交）｜ 数值 =（价格/买点−1）×100% ｜ 未计手续费与滑点', { size: 13, fill: C.faint });
  y += 118;

  // ---------- KPI 卡片 ----------
  const cards = [
    { label: 'T+1 最高涨幅（次日冲高）', main: sg(mean(t1High)) + '%', sub: `中位 ${sg(median(t1High))}%　胜率 ${pctOf(t1High, (x) => x > 0).toFixed(1)}%`, color: C.green },
    { label: 'T+1 最低涨幅（次日回撤）', main: sg(mean(t1Low)) + '%', sub: `中位 ${sg(median(t1Low))}%　跌破−2% 占 ${pctOf(t1Low, (x) => x <= -2).toFixed(1)}%`, color: C.red },
    { label: 'T+5 收盘涨幅累加', main: sg(mean(sumClose5)) + '%', sub: `中位 ${sg(median(sumClose5))}%　胜率 ${pctOf(sumClose5, (x) => x > 0).toFixed(1)}%`, color: C.amber },
    { label: 'T+5 期间最高（理想）', main: sg(mean(t5Max)) + '%', sub: `中位 ${sg(median(t5Max))}%　胜率 ${pctOf(t5Max, (x) => x > 0).toFixed(1)}%`, color: C.blue },
  ];
  const cw = (CW - 3 * 18) / 4;
  cards.forEach((c, i) => {
    const x = PAD + i * (cw + 18);
    rect(x, y, cw, 116, C.panel, 12, C.border);
    out2.push(`<rect x="${x}" y="${y}" width="4" height="116" rx="2" fill="${c.color}"/>`);
    text(x + 20, y + 28, c.label, { size: 13.5, fill: C.dim });
    text(x + 20, y + 68, c.main, { size: 32, weight: '700', fill: c.color });
    text(x + 20, y + 96, c.sub, { size: 13, fill: C.faint });
  });
  y += 116 + 34;

  // ---------- 表格工具 ----------
  function sectionTitle(s: string, sub?: string) {
    y += 8;
    text(PAD, y + 4, s, { size: 19, weight: '700' });
    if (sub) text(PAD, y + 26, sub, { size: 13, fill: C.faint });
    y += sub ? 40 : 26;
  }
  function table(cols: { title: string; w: number; align?: 'l' | 'r' }[], data: string[][], opt: { hi?: (r: number) => boolean } = {}) {
    const hh = 38, rh = 38;
    rect(PAD, y, CW, hh + data.length * rh, C.panel, 12, C.border);
    let x = PAD;
    cols.forEach((c) => {
      const tx = c.align === 'r' ? x + c.w - 16 : x + 16;
      text(tx, y + 25, c.title, { size: 13.5, fill: C.dim, anchor: c.align === 'r' ? 'end' : 'start' });
      x += c.w;
    });
    out2.push(`<line x1="${PAD}" y1="${y + hh}" x2="${PAD + CW}" y2="${y + hh}" stroke="${C.border}" stroke-width="1"/>`);
    data.forEach((row, ri) => {
      const ry = y + hh + ri * rh;
      if (opt.hi?.(ri)) rect(PAD + 1, ry, CW - 2, rh, C.panelAlt, 0);
      let cx = PAD;
      cols.forEach((c, ci) => {
        const v = row[ci] ?? '';
        const tx = c.align === 'r' ? cx + c.w - 16 : cx + 16;
        text(tx, ry + 25, v, { size: 14, fill: ci === 0 ? C.text : C.text, anchor: c.align === 'r' ? 'end' : 'start' });
        cx += c.w;
      });
      if (ri < data.length - 1) out2.push(`<line x1="${PAD + 16}" y1="${ry + rh}" x2="${PAD + CW - 16}" y2="${ry + rh}" stroke="${C.border}" stroke-width="0.5" opacity="0.6"/>`);
    });
    y += hh + data.length * rh + 34;
  }

  // ---------- 表 1：退出方式 ----------
  sectionTitle('一、各退出方式对比 —— 钱在 T+1 的盘中冲高，不在收盘', 'T+1 冲高（理想）比格局到 T+5 收盘高 1.52pp，66.4% 的样本冲高更优');
  table(
    [
      { title: '退出方式', w: 400 },
      { title: '平均', w: 210, align: 'r' },
      { title: '中位', w: 210, align: 'r' },
      { title: '胜率（>0）', w: CW - 820, align: 'r' },
    ],
    [
      ['T+1 开盘卖', sg(mean(t1Open)) + '%', sg(median(t1Open)) + '%', pctOf(t1Open, (x) => x > 0).toFixed(1) + '%'],
      ['T+1 收盘卖', sg(mean(t1Close)) + '%', sg(median(t1Close)) + '%', pctOf(t1Close, (x) => x > 0).toFixed(1) + '%'],
      ['T+1 盘中最高卖（理想）', sg(mean(t1High)) + '%', sg(median(t1High)) + '%', pctOf(t1High, (x) => x > 0).toFixed(1) + '%'],
      ['T+3 收盘卖', sg(mean(rows.map((r) => r.fwd![2].c))) + '%', sg(median(rows.map((r) => r.fwd![2].c))) + '%', pctOf(rows.map((r) => r.fwd![2].c), (x) => x > 0).toFixed(1) + '%'],
      ['T+5 收盘卖（格局 5 日）', sg(mean(t5Close)) + '%', sg(median(t5Close)) + '%', pctOf(t5Close, (x) => x > 0).toFixed(1) + '%'],
      ['T+5 期间最高卖（理想）', sg(mean(t5Max)) + '%', sg(median(t5Max)) + '%', pctOf(t5Max, (x) => x > 0).toFixed(1) + '%'],
    ],
    { hi: (r) => r === 2 }
  );

  // ---------- 图 1：T+1 冲高分布 ----------
  sectionTitle('二、T+1 冲高分布 —— 中位 1.37%，六成样本能冲到 1% 以上');
  const buckets: [string, (x: number) => boolean][] = [
    ['<0', (x) => x < 0], ['0~1%', (x) => x >= 0 && x < 1], ['1~2%', (x) => x >= 1 && x < 2],
    ['2~3%', (x) => x >= 2 && x < 3], ['3~5%', (x) => x >= 3 && x < 5], ['≥5%', (x) => x >= 5],
  ];
  const bcounts = buckets.map(([, f]) => t1High.filter(f).length);
  const bmax = Math.max(...bcounts);
  {
    const H = 170, chartY = y + 18, bw = CW / buckets.length;
    rect(PAD, y, CW, H + 58, C.panel, 12, C.border);
    buckets.forEach(([label], i) => {
      const h = (bcounts[i] / bmax) * H;
      const x = PAD + i * bw + bw * 0.18;
      const w = bw * 0.64;
      const col = i === 0 ? C.red : i <= 2 ? C.amber : C.green;
      out2.push(`<rect x="${x}" y="${chartY + H - h}" width="${w}" height="${h}" rx="6" fill="${col}" opacity="0.85"/>`);
      text(x + w / 2, chartY + H - h - 8, String(bcounts[i]), { size: 13, fill: C.text, anchor: 'middle' });
      text(x + w / 2, chartY + H + 22, label, { size: 13.5, fill: C.dim, anchor: 'middle' });
      text(x + w / 2, chartY + H + 40, ((bcounts[i] / rows.length) * 100).toFixed(1) + '%', { size: 12, fill: C.faint, anchor: 'middle' });
    });
    y += H + 58 + 16;
    text(PAD, y + 12, `分位：p25 ${sg(q(t1High, 0.25))}%　中位 ${sg(median(t1High))}%　p75 ${sg(q(t1High, 0.75))}%　p90 ${sg(q(t1High, 0.9))}%　　冲高≥2% 占 ${pctOf(t1High, (x) => x >= 2).toFixed(1)}%　冲高≥3% 占 ${pctOf(t1High, (x) => x >= 3).toFixed(1)}%`, { size: 13, fill: C.dim });
    y += 52;
  }

  // ---------- 图 2：次日回撤 ----------
  sectionTitle('三、次日回撤 —— 约 28% 的样本次日盘中跌破买点 2% 以上');
  {
    const H = 140, chartY = y + 18, items = [-1, -2, -3, -5, -7];
    const vals = items.map((th) => pctOf(t1Low, (x) => x <= th));
    const bw = CW / items.length;
    rect(PAD, y, CW, H + 58, C.panel, 12, C.border);
    items.forEach((th, i) => {
      const h = (vals[i] / vals[0]) * H;
      const x = PAD + i * bw + bw * 0.18, w = bw * 0.64;
      out2.push(`<rect x="${x}" y="${chartY + H - h}" width="${w}" height="${h}" rx="6" fill="${C.red}" opacity="${0.9 - i * 0.13}"/>`);
      text(x + w / 2, chartY + H - h - 8, vals[i].toFixed(1) + '%', { size: 13, fill: C.text, anchor: 'middle' });
      text(x + w / 2, chartY + H + 22, `跌破 ${th}%`, { size: 13.5, fill: C.dim, anchor: 'middle' });
    });
    y += H + 58 + 16;
    text(PAD, y + 12, `T+1 最低：平均 ${sg(mean(t1Low))}%　中位 ${sg(median(t1Low))}%　　 T+1..T+5 期间最低：平均 ${sg(mean(worst5))}%　中位 ${sg(median(worst5))}%　　 T+1 全天未翻红占 ${pctOf(t1High, (x) => x <= 0).toFixed(1)}%`, { size: 13, fill: C.dim });
    y += 52;
  }

  // ---------- 图 3：冲高分档 × 卖出方式 ----------
  sectionTitle('四、关键发现：T+1 冲多高，决定了后面还能不能赚', '冲高 <1% 的 39.6% 样本无论怎么卖都是亏的；只有冲高 ≥2% 的 35% 样本才有正收益');
  {
    const names = buckets.map(([l]) => l);
    const aVals = buckets.map(([, f]) => mean(rows.filter((r) => f(r.fwd![0].h)).map((r) => r.fwd![0].c)));
    const bVals = buckets.map(([, f]) => mean(rows.filter((r) => f(r.fwd![0].h)).map((r) => r.fwd![4].c)));
    const ns = buckets.map(([, f]) => rows.filter((r) => f(r.fwd![0].h)).length);
    const H = 250;
    const all = [...aVals, ...bVals, 0];
    const lo = Math.min(...all, -1), hi = Math.max(...all, 1);
    const span = hi - lo;
    const scale = (v: number) => (v - lo) / span;
    const chartTop = y + 46, chartH = H, zeroY = chartTop + chartH * (1 - scale(0));
    const bw = CW / names.length;
    rect(PAD, y, CW, H + 128, C.panel, 12, C.border);
    out2.push(`<line x1="${PAD + 20}" y1="${zeroY}" x2="${PAD + CW - 20}" y2="${zeroY}" stroke="${C.border}" stroke-width="1.5"/>`);
    text(PAD + 20, zeroY - 6, '0', { size: 11, fill: C.faint });
    names.forEach((nm, i) => {
      const x0 = PAD + i * bw;
      const barW = bw * 0.26;
      [aVals[i], bVals[i]].forEach((v, k) => {
        const yy = chartTop + chartH * (1 - scale(Math.max(v, 0)));
        const h = Math.abs(chartTop + chartH * (1 - scale(v)) - zeroY);
        const col = k === 0 ? C.blue : C.purple;
        out2.push(`<rect x="${x0 + bw * (0.16 + k * 0.32)}" y="${v >= 0 ? yy : zeroY}" width="${barW}" height="${Math.max(h, 2)}" rx="4" fill="${col}" opacity="0.9"/>`);
        text(x0 + bw * (0.16 + k * 0.32) + barW / 2, v >= 0 ? yy - 6 : zeroY + h + 14, sg(v), { size: 11.5, fill: col, anchor: 'middle' });
      });
      text(x0 + bw / 2, chartTop + chartH + 26, nm, { size: 13.5, fill: C.dim, anchor: 'middle' });
      text(x0 + bw / 2, chartTop + chartH + 44, `n=${ns[i]}`, { size: 11.5, fill: C.faint, anchor: 'middle' });
    });
    // 图例
    const ly = chartTop + chartH + 74;
    out2.push(`<rect x="${PAD + 20}" y="${ly - 9}" width="12" height="12" rx="3" fill="${C.blue}"/>`);
    text(PAD + 40, ly + 1, 'T+1 收盘卖', { size: 13, fill: C.dim });
    out2.push(`<rect x="${PAD + 150}" y="${ly - 9}" width="12" height="12" rx="3" fill="${C.purple}"/>`);
    text(PAD + 170, ly + 1, 'T+5 收盘卖（格局 5 日）', { size: 13, fill: C.dim });
    text(PAD + 420, ly + 1, '"格局更优" 的比例在每一档都 <50%（45%~48%），且中位数更低 —— 格局靠少数大赢拉均值', { size: 12.5, fill: C.amber });
    y += H + 128 + 16;
  }

  // ---------- 表 2：分年 ----------
  sectionTitle('五、分年稳健性', 'T+1 冲高五年稳定（均值 1.74%~2.00%）；T+5 收盘三年为零或负 —— "格局"没有稳定收益');
  const years = [...new Set(rows.map((r) => r.year))].sort();
  table(
    [
      { title: '年份', w: 150 },
      { title: '样本', w: 150, align: 'r' },
      { title: 'T+1 最高 平均 / 中位', w: 290, align: 'r' },
      { title: 'T+1 最低 平均 / 中位', w: 290, align: 'r' },
      { title: 'T+5 收盘 平均 / 中位', w: CW - 880, align: 'r' },
    ],
    years.map((yy) => {
      const sub = rows.filter((r) => r.year === yy);
      const a = sub.map((r) => r.fwd![0].h), b = sub.map((r) => r.fwd![0].l), c = sub.map((r) => r.fwd![4].c);
      return [yy, String(sub.length), `${sg(mean(a))}% / ${sg(median(a))}%`, `${sg(mean(b))}% / ${sg(median(b))}%`, `${sg(mean(c))}% / ${sg(median(c))}%`];
    })
  );

  // ---------- 结论条 ----------
  rect(PAD, y, CW, 96, C.panelAlt, 12, C.border);
  out2.push(`<rect x="${PAD}" y="${y}" width="4" height="96" rx="2" fill="${C.blue}"/>`);
  text(PAD + 20, y + 32, '结论：钱在 T+1 的盘中冲高，不在收盘。', { size: 17, weight: '700', fill: C.blue });
  text(PAD + 20, y + 58, '格局到 T+5 收盘平均仅 +0.38%、中位 0.00%、胜率 48.8%，且要多承担 −2.80%（中位）的期间回撤。', { size: 13.5, fill: C.dim });
  text(PAD + 20, y + 80, '实操上：T+1 若冲高不足 1%，当日收盘了结；冲高 ≥2% 才考虑拿一拿。', { size: 13.5, fill: C.dim });
  y += 96 + 28;

  const H = Math.ceil(y + PAD);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect width="${W}" height="${H}" fill="${C.bg}"/>` + out2.join('') + '</svg>';
  writeFileSync(out.replace(/\.png$/, '.svg'), svg);
  sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(out)
    .then((info) => console.log(`✅ ${out}  ${info.width}x${info.height}  ${(info.size / 1024).toFixed(0)}KB`))
    .catch((e) => { console.error('渲染失败:', e.message); process.exit(1); });
}

main();
