/**
 * 仙人指路 — 收益结构报表（离线，无 DB）
 *
 * 回答两个问题：
 *   ① T+1 冲高卖 vs 格局到 T+5 收盘，哪个性价比高？
 *   ② 次日（T+1）最大回撤有多大？
 *
 * 口径：买点 = 确认日（T1）收盘；T+1..T+5 为之后 5 个交易日。
 *   所有指标= (价格 / 买点 - 1) × 100%，全部给 平均 + 中位（中位更抗极值）。
 *
 * 用法：
 *   npx tsx scripts/report-xianren-returns.ts --file=.tmp/xr-path.json
 *   npx tsx scripts/report-xianren-returns.ts --file=... --year=2024     # 单年
 */

import { readFileSync } from 'fs';

interface Path { o: number; c: number; h: number; l: number }
interface Row {
  code: string; date: string; year: string;
  rT1: number; rT5: number;
  fwd?: Path[];
}

const round = (n: number, d = 2): number => {
  const p = Math.pow(10, d);
  return Math.round(n * p) / p;
};

function mean(a: number[]): number {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
}
function median(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function pct(a: number[], f: (x: number) => boolean): number {
  return a.length ? round((a.filter(f).length / a.length) * 100, 1) : 0;
}

function fmt(a: number[]): string {
  return `${mean(a).toFixed(2).padStart(7)}%  ${median(a).toFixed(2).padStart(7)}%`;
}

function main(): void {
  const args = process.argv.slice(2);
  const fileArg = args.find((a) => a.startsWith('--file='));
  const file = fileArg ? fileArg.slice('--file='.length) : '.tmp/xr-path.json';
  const yearArg = args.find((a) => a.startsWith('--year='));
  const year = yearArg ? yearArg.slice('--year='.length) : null;

  const data = JSON.parse(readFileSync(file, 'utf8')) as { rows: Row[] };
  let rows = data.rows.filter((r) => Array.isArray(r.fwd) && r.fwd.length === 5);
  if (year) rows = rows.filter((r) => r.year === year);
  if (!rows.length) { console.log('无样本（检查 --file / --year）'); return; }

  const title = year ? `仙人指路 · ${year} 年` : '仙人指路 · 全部年份（2022-2026，已剔 924）';
  console.log(`\n${title}   n=${rows.length}`);
  console.log('买点 = 确认日(T1)收盘；所有数值 = (价格/买点-1)×100%\n');

  // ---------- 问题①：各类退出方式对比 ----------
  const t1High = rows.map((r) => r.fwd![0].h);        // T+1 盘中最高
  const t1Close = rows.map((r) => r.fwd![0].c);       // T+1 收盘
  const t1Open = rows.map((r) => r.fwd![0].o);        // T+1 开盘
  const t5Close = rows.map((r) => r.fwd![4].c);       // T+5 收盘（格局 5 日）
  const t5MaxHigh = rows.map((r) => Math.max(...r.fwd!.map((d) => d.h))); // 5 日内最高（理想）
  const t3Close = rows.map((r) => r.fwd![2].c);
  const t2Close = rows.map((r) => r.fwd![1].c);

  /** 逐日收盘涨幅的算术累加（T+1..T+5）：r1 = c1/entry-1；r_i = c_i/c_{i-1}-1 */
  const closePctSeries = (r: Row): number[] => {
    const out: number[] = [];
    let prev = 0; // 相对买点的累计涨幅（买点=0）
    for (const d of r.fwd!) {
      out.push(((d.c - prev) / (100 + prev)) * 100);
      prev = d.c;
    }
    return out;
  };
  const sumClose = (n: number) => rows.map((r) => closePctSeries(r).slice(0, n).reduce((a, b) => a + b, 0));

  console.log('【一】退出方式对比（哪个性价比高）');
  console.log('  退出方式'.padEnd(26) + '平均'.padStart(8) + '中位'.padStart(9) + '胜率'.padStart(8));
  const exits: [string, number[]][] = [
    ['T+1 开盘卖', t1Open],
    ['T+1 收盘卖', t1Close],
    ['T+1 盘中最高卖（理想）', t1High],
    ['T+2 收盘卖', t2Close],
    ['T+3 收盘卖', t3Close],
    ['T+5 收盘卖（格局 5 日）', t5Close],
    ['T+5 期间最高卖（理想）', t5MaxHigh],
  ];
  for (const [name, arr] of exits) {
    console.log('  ' + name.padEnd(24) + fmt(arr) + String(pct(arr, (x) => x > 0)).padStart(7) + '%');
  }

  console.log('\n【一·补】收盘涨幅「累加」口径（逐日收盘涨幅之和，即你说的 T+N 累加）');
  console.log('  口径'.padEnd(26) + '平均'.padStart(8) + '中位'.padStart(9) + '胜率'.padStart(8));
  for (const n of [1, 2, 3, 5]) {
    const arr = sumClose(n);
    console.log('  ' + (`T+1..T+${n} 收盘涨幅累加`).padEnd(24) + fmt(arr) + String(pct(arr, (x) => x > 0)).padStart(7) + '%');
  }
  console.log('  ' + '（对照）T+5 收盘累计=复利'.padEnd(23) + fmt(t5Close) + String(pct(t5Close, (x) => x > 0)).padStart(7) + '%');
  console.log('  说明：两者差异极小（单日波动小，算术和≈复利），可任取其一。');

  // ---------- 问题②：回撤 ----------
  const t1Low = rows.map((r) => r.fwd![0].l);           // T+1 最低
  const worst5 = rows.map((r) => Math.min(...r.fwd!.map((d) => d.l))); // 5 日内最低
  const t1Range = rows.map((r) => r.fwd![0].h - r.fwd![0].l);

  console.log('\n【二】回撤（相对买点，负数=跌破买点）');
  console.log('  指标'.padEnd(26) + '平均'.padStart(8) + '中位'.padStart(9));
  console.log('  ' + 'T+1 最低（次日最大回撤）'.padEnd(24) + fmt(t1Low));
  console.log('  ' + 'T+1..T+5 期间最低'.padEnd(24) + fmt(worst5));
  console.log('  ' + 'T+1 振幅（最高-最低）'.padEnd(24) + fmt(t1Range));

  console.log('\n  T+1 最低跌幅分布：');
  for (const th of [-1, -2, -3, -5, -7]) {
    console.log(`    跌破 ${String(th).padStart(2)}% 的比例：${String(pct(t1Low, (x) => x <= th)).padStart(5)}%`);
  }
  console.log('    T+1 全天未翻红（最高<=0）比例：' + pct(rows.map((r) => r.fwd![0].h), (x) => x <= 0) + '%');

  // ---------- 冲高 vs 格局 的直接对比 ----------
  console.log('\n【三】"T+1 冲高出" vs "格局到 T+5 收盘"');
  const diff = rows.map((r) => r.fwd![4].c - r.fwd![0].h); // 格局 - 冲高
  console.log('  格局(T+5收盘) − T+1冲高：平均 ' + round(mean(diff)) + '%  中位 ' + round(median(diff)) + '%');
  console.log('  格局更优的比例：' + pct(diff, (x) => x > 0) + '%');
  console.log('  T+1 冲高 > T+5 收盘 的比例：' + pct(diff, (x) => x < 0) + '%');
  console.log('  两者相等（同日同价）比例：' + pct(diff, (x) => x === 0) + '%');
  const t1HighAbs = t1High.filter((x) => x > 0);
  console.log(`  注：T+1 冲高是「理想卖点」，实战难抓满；T+5 收盘是可确定成交价。`);
  console.log(`      T+1 冲高为正的样本占 ${pct(t1High, (x) => x > 0)}%，其均值 ${round(mean(t1HighAbs))}%`);

  // ---------- 冲高分位与分布 ----------
  const q = (a: number[], p: number) => {
    const s2 = [...a].sort((x, y) => x - y);
    return s2[Math.min(s2.length - 1, Math.floor(s2.length * p))];
  };
  console.log('');
  console.log('【五】T+1 冲高（当日最高）分位与达标比例');
  console.log(`  分位：p10 ${q(t1High, 0.1).toFixed(2)}%   p25 ${q(t1High, 0.25).toFixed(2)}%   中位 ${median(t1High).toFixed(2)}%   p75 ${q(t1High, 0.75).toFixed(2)}%   p90 ${q(t1High, 0.9).toFixed(2)}%`);
  for (const th of [1, 2, 3, 5, 7]) {
    console.log(`  冲高 ≥ +${th}% 的比例：${String(pct(t1High, (x) => x >= th)).padStart(5)}%`);
  }

  // ---------- 条件分析：T+1 冲得不够时，格局是否更好 ----------
  console.log('');
  console.log('【六】条件分析——按 T+1 最高涨幅分档，看「T+1 收盘卖 vs 格局到 T+5 收盘」');
  console.log('  档位'.padEnd(16) + 'n'.padStart(6) + 'T+1收盘卖'.padStart(22) + 'T+5收盘卖'.padStart(22) + '格局更优比例'.padStart(12));
  const buckets: [string, (x: number) => boolean][] = [
    ['T+1最高 < 0', (x) => x < 0],
    ['0 ~ 1%', (x) => x >= 0 && x < 1],
    ['1 ~ 2%', (x) => x >= 1 && x < 2],
    ['2 ~ 3%', (x) => x >= 2 && x < 3],
    ['3 ~ 5%', (x) => x >= 3 && x < 5],
    ['>= 5%', (x) => x >= 5],
  ];
  for (const [label, test] of buckets) {
    const sub = rows.filter((r) => test(r.fwd![0].h));
    if (!sub.length) { console.log('  ' + label.padEnd(14) + '0'.padStart(6)); continue; }
    const a = sub.map((r) => r.fwd![0].c);
    const b = sub.map((r) => r.fwd![4].c);
    const better = pct(b.map((x, i) => x - a[i]), (x) => x > 0);
    console.log(
      '  ' + label.padEnd(14) + String(sub.length).padStart(6) +
      (`  ${mean(a).toFixed(2)}% / 中位 ${median(a).toFixed(2)}%`).padStart(22) +
      (`  ${mean(b).toFixed(2)}% / 中位 ${median(b).toFixed(2)}%`).padStart(22) +
      String(better).padStart(11) + '%'
    );
  }

  // ---------- 分年（看稳健性） ----------
  const years = [...new Set(data.rows.map((r) => r.year))].sort();
  if (!year && years.length > 1) {
    console.log('\n【四】分年（平均 / 中位 / 胜率）');
    console.log('  年份'.padEnd(8) + 'n'.padStart(6) + 'T+1最高'.padStart(18) + 'T+1最低'.padStart(18) + 'T+5收盘'.padStart(18));
    for (const y of years) {
      const sub = rows.filter((r) => r.year === y);
      if (!sub.length) continue;
      const a = sub.map((r) => r.fwd![0].h);
      const b = sub.map((r) => r.fwd![0].l);
      const c = sub.map((r) => r.fwd![4].c);
      console.log(
        '  ' + y.padEnd(6) + String(sub.length).padStart(6) +
        ('  ' + mean(a).toFixed(2) + '%/' + median(a).toFixed(2) + '%').padStart(20) +
        ('  ' + mean(b).toFixed(2) + '%/' + median(b).toFixed(2) + '%').padStart(20) +
        ('  ' + mean(c).toFixed(2) + '%/' + median(c).toFixed(2) + '%').padStart(20)
      );
    }
  }
}

main();
