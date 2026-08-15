/**
 * 预警规则探索性回放（第0步，不落库）— 评估预警回测回路的价值
 *
 * 对抽样标的逐日重放 checkAllRules（收盘口径：quote=null 时盘中折算退化为全日量），
 * 记录全部规则触发及其 T+5/T+10/T+20 前向收益，输出：
 *   - 全样本基准胜率（对照线：什么都不触发时 T+5 涨概率）
 *   - 各规则/子信号触发次数 / 胜率 / 均值（R01/R02 按子信号，R03-R14 按规则名）
 *   - 分年 T+5 胜率（10 年窗口跨牛熊验证用）
 *   - 巨量见顶按量比分桶、第二波按第一波倍数分桶的胜率曲线
 *
 * 2026-08-15：放开 R01/R02 限制（买入侧 R04-R12 首次纳入回放）；
 * 前向窗口扩到 T+20（循环尾部留 20 根）；删除「放量离场」分桶（规则 08-05 已删）。
 * 注：R13/R14 需筹码数据，回放 chip=null 恒不触发，不出现在报告里属正常。
 *
 * 不写任何表（默认）；加 --write 时把触发样本落库 alert_rule_triggers(source=replay, 带触发参数)，
 * 供健康监控/周回顾立刻有历史数据。结论用于决定：值不值得建正式回测回路 + 系数扫描。
 *
 * 用法: npx tsx scripts/explore-alert-rules.ts [--days=500] [--stocks=800] [--write]
 * 10 年全量: NODE_OPTIONS="--max-old-space-size=3584" npx tsx scripts/explore-alert-rules.ts --days=2350
 */

import { prisma } from '../lib/db';
import { checkAllRules, ALERT_RULES } from '../services/alertRules';
import type { KLineData } from '../types';

const DAYS = parseInt(process.argv.find((a) => a.startsWith('--days='))?.split('=')[1] || '500');
const MAX_STOCKS = parseInt(process.argv.find((a) => a.startsWith('--stocks='))?.split('=')[1] || '800');
const WRITE = process.argv.includes('--write');

interface Acc { n: number; t5s: number[]; t10s: number[]; t20s: number[] }
const newAcc = (): Acc => ({ n: 0, t5s: [], t10s: [], t20s: [] });
const push = (map: Map<string, Acc>, k: string, t5: number, t10: number, t20: number) => {
  let a = map.get(k);
  if (!a) { a = newAcc(); map.set(k, a); }
  a.n++; a.t5s.push(t5); a.t10s.push(t10); a.t20s.push(t20);
};

const winRate = (xs: number[]) => (xs.length ? Math.round((xs.filter((x) => x > 0).length / xs.length) * 1000) / 10 : null);
const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);

const avgVol = (win: KLineData[], period: number) => {
  const s = win.slice(-period);
  if (s.length < period) return 0;
  return s.reduce((a, k) => a + k.volume, 0) / period;
};

function fmt(k: string, a: Acc) {
  return `${k.padEnd(14)} 触发${String(a.n).padStart(6)}次  T+5胜率${String(winRate(a.t5s)).padStart(5)}%  T+5均值${String(mean(a.t5s)).padStart(6)}%  T+20胜率${String(winRate(a.t20s)).padStart(5)}%  T+20均值${String(mean(a.t20s)).padStart(6)}%`;
}

/** 分桶统计：key = 桶标签, 值 = {n, win5, avg5} */
function bucketReport(map: Map<string, Acc>, title: string) {
  console.log(`\n=== ${title} ===`);
  if (map.size === 0) { console.log('（无样本）'); return; }
  for (const [k, a] of [...map.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
    console.log(`  桶 ${k.padEnd(14)} 样本${String(a.n).padStart(5)}  T+5胜率${String(winRate(a.t5s)).padStart(5)}%  T+5均值${String(mean(a.t5s)).padStart(6)}%`);
  }
}

async function main() {
  // 1. 最新交易日 + 抽样标的（最近有成交的票，均匀步长取 MAX_STOCKS）
  const latest = await prisma.dailyBar.findFirst({ orderBy: { tradeDate: 'desc' }, select: { tradeDate: true } });
  if (!latest) throw new Error('daily_bars 无数据');
  const active = await prisma.dailyBar.findMany({
    where: { tradeDate: latest.tradeDate },
    select: { tsCode: true },
    distinct: ['tsCode'],
  });
  const step = Math.max(1, Math.ceil(active.length / MAX_STOCKS));
  const sample = active.filter((_, i) => i % step === 0).slice(0, MAX_STOCKS).map((s) => s.tsCode);
  console.log(`[explore] 最新交易日 ${latest.tradeDate}，活跃 ${active.length} 只，抽样 ${sample.length} 只（步长 ${step}）`);

  // 2. 取历史窗口起点（最近 DAYS 个交易日）
  const days = await prisma.$queryRawUnsafe<{ tradeDate: string }[]>(
    `SELECT DISTINCT "tradeDate" FROM daily_bars WHERE "tradeDate" <= '${latest.tradeDate}' ORDER BY "tradeDate" DESC`
  );
  const startDate = days[Math.min(days.length - 1, DAYS)]?.tradeDate ?? '20240101';
  console.log(`[explore] 回放窗口 ${startDate} ~ ${latest.tradeDate}（${Math.min(days.length, DAYS)} 个交易日）`);

  // 3. 拉数据（内存分组）
  const bars = await prisma.dailyBar.findMany({
    where: { tsCode: { in: sample }, tradeDate: { gte: startDate } },
    select: { tsCode: true, tradeDate: true, open: true, high: true, low: true, close: true, vol: true },
    orderBy: [{ tsCode: 'asc' }, { tradeDate: 'asc' }],
  });
  const byStock = new Map<string, KLineData[]>();
  for (const b of bars) {
    if (b.open == null || b.close == null || b.vol == null) continue;
    let arr = byStock.get(b.tsCode);
    if (!arr) { arr = []; byStock.set(b.tsCode, arr); }
    arr.push({ date: b.tradeDate, open: b.open, high: b.high ?? 0, low: b.low ?? 0, close: b.close, volume: b.vol });
  }
  console.log(`[explore] 有效标的 ${byStock.size} 只，K线 ${bars.length} 根`);

  // 4. 逐日重放
  const ruleName = new Map(ALERT_RULES.map((r) => [r.id, r.name]));
  const labelMap = new Map<string, Acc>();           // key = "R01 巨量见顶" / "R04 5/13金叉"
  const yearMap = new Map<string, Map<string, Acc>>(); // key → 年份 → Acc（分年跨牛熊验证）
  const bucketPeak = new Map<string, Acc>();    // 巨量见顶：量比
  const bucketSecond = new Map<string, Acc>();  // 第二波见顶：第二波/第一波
  let baselineN = 0, baselineWin5 = 0, baselineSum5 = 0, baselineWin20 = 0, baselineSum20 = 0;
  const enabled = ALERT_RULES.filter((r) => r.isEnabled);
  const writeRows: { tsCode: string; stockName?: string; ruleId: string; subLabel: string; barDate: string; params: string | null; source: 'replay' }[] = [];

  let processed = 0;
  for (const [code, arr] of byStock) {
    if (arr.length < 90) continue;
    for (let i = 60; i < arr.length - 20; i++) {
      const win = arr.slice(i - 119, i + 1);
      const t5 = (arr[i + 5].close / arr[i].close - 1) * 100;
      const t10 = (arr[i + 10].close / arr[i].close - 1) * 100;
      const t20 = (arr[i + 20].close / arr[i].close - 1) * 100;
      baselineN++;
      if (t5 > 0) baselineWin5++;
      baselineSum5 += t5;
      if (t20 > 0) baselineWin20++;
      baselineSum20 += t20;

      const res = checkAllRules(win, null, enabled);
      for (const r of res) {
        if (!r.ruleId) continue;
        // R01/R02 阶梯按子信号（extraData.main）统计；单信号规则按规则名统计
        let label = ruleName.get(r.ruleId) ?? r.ruleId;
        if (r.ruleId === 'R01' || r.ruleId === 'R02') {
          try { label = JSON.parse(r.extraData ?? '{}').main ?? label; } catch { /* ignore */ }
        }
        const key = `${r.ruleId} ${label}`;
        push(labelMap, key, t5, t10, t20);
        const year = arr[i].date.slice(0, 4);
        let ym = yearMap.get(key);
        if (!ym) { ym = new Map(); yearMap.set(key, ym); }
        push(ym, year, t5, t10, t20);

        // 分桶参数重算（收盘口径与规则内部一致：quote=null → effVol=今日全日量）
        const today = arr[i];
        let params: Record<string, number> | null = null;
        if (label === '巨量见顶') {
          const avg20 = avgVol(win, 20);
          const ratio = avg20 > 0 ? today.volume / avg20 : 0;
          params = { volRatio20: Math.round(ratio * 10) / 10 };
          const b = ratio >= 4 ? '≥4x' : ratio >= 3 ? '3-4x' : ratio >= 2.5 ? '2.5-3x' : ratio >= 2 ? '2-2.5x' : `近线${ratio.toFixed(1)}x`;
          push(bucketPeak, b, t5, t10, t20);
        } else if (label === '第二波见顶') {
          const firstWaveMax = Math.max(...win.slice(0, -5).map((k) => k.volume));
          const secondWaveMax = Math.max(...win.slice(-5, -1).map((k) => k.volume));
          const ratio = firstWaveMax > 0 ? secondWaveMax / firstWaveMax : 0;
          params = { ratio: Math.round(ratio * 100) / 100 };
          const b = ratio >= 1.2 ? '≥1.2x' : ratio >= 1.1 ? '1.1-1.2x' : ratio >= 1.0 ? '1.0-1.1x' : '0.9-1.0x';
          push(bucketSecond, b, t5, t10, t20);
        }
        // --write：落库回放样本（健康卡/周报数据源）
        if (WRITE) {
          const subs: string[] = [];
          try { const ex = JSON.parse(r.extraData ?? '{}'); subs.push(...(ex.triggered ?? [])); } catch { /* ignore */ }
          for (const s of (subs.length ? subs : [label])) {
            writeRows.push({
              tsCode: code, ruleId: r.ruleId!, subLabel: s, barDate: arr[i].date,
              params: params ? JSON.stringify(params) : null,
              source: 'replay',
            });
          }
        }
      }
    }
    processed++;
    if (processed % 100 === 0) console.log(`[explore] 进度 ${processed}/${byStock.size}`);
  }

  // 5. 报告
  console.log(`\n[explore] 回放完成：${baselineN} 个标的日`);

  // 5.5 --write：回放样本落库（createMany 分批 + skipDuplicates 幂等）
  if (WRITE && writeRows.length > 0) {
    const now = new Date().toISOString();
    let written = 0;
    for (let i = 0; i < writeRows.length; i += 5000) {
      const batch = writeRows.slice(i, i + 5000).map((r) => ({ ...r, createdAt: now }));
      const res = await prisma.alertRuleTrigger.createMany({ data: batch, skipDuplicates: true });
      written += res.count;
    }
    console.log(`[explore] 落库回放样本 ${written}/${writeRows.length} 条（重复跳过）`);
  }

  // 基准线
  console.log('\n=== 基准对照（全部样本日，无条件） ===');
  console.log(`  全样本 T+5 胜率 ${Math.round((baselineWin5 / baselineN) * 1000) / 10}%  均值 ${Math.round((baselineSum5 / baselineN) * 100) / 100}%  |  T+20 胜率 ${Math.round((baselineWin20 / baselineN) * 1000) / 10}%  均值 ${Math.round((baselineSum20 / baselineN) * 100) / 100}%`);

  // 规则/子信号汇总（key 带 ruleId 前缀，按触发数排序）
  console.log('\n=== 规则触发统计（T+5/T+20 绝对收益；R01/R02 按子信号，其余按规则） ===');
  const labels = [...labelMap.entries()].sort((a, b) => b[1].n - a[1].n);
  for (const [k, a] of labels) console.log(`  ${fmt(k, a)}`);

  // 分年 T+5 胜率（跨牛熊验证：2018 熊市 / 2024 微盘崩盘里规则还灵不灵）
  console.log('\n=== 分年 T+5 胜率（触发年，括号内样本数；<30 样本标 * 仅供参考） ===');
  const years = [...new Set([...yearMap.values()].flatMap((m) => [...m.keys()]))].sort();
  for (const [k] of labels) {
    const ym = yearMap.get(k)!;
    const cells = years.map((y) => {
      const a = ym.get(y);
      if (!a || a.n === 0) return `${y}:--`;
      const w = winRate(a.t5s);
      return `${y}:${w}${a.n < 30 ? '*' : ''}(${a.n})`;
    });
    console.log(`  ${k.padEnd(14)} ${cells.join('  ')}`);
  }

  // 分桶
  bucketReport(bucketPeak, '巨量见顶 · 按量比(今日/20日均)分桶');
  bucketReport(bucketSecond, '第二波见顶 · 按第二波/第一波比例分桶');

  console.log('\n[explore] 说明：收盘口径重放（盘中折算退化为全日量），量能类规则样本与盘中实况有偏差；未分大盘环境。');
  await prisma.$disconnect();
}

main().catch((e) => { console.error('[explore] 失败:', e); process.exit(1); });
