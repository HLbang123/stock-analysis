/**
 * 预警规则探索性回放（第0步，不落库）— 评估预警回测回路的价值
 *
 * 对抽样标的逐日重放 checkAllRules（收盘口径：quote=null 时盘中折算退化为全日量），
 * 记录 R01/R02 各子信号触发及其 T+5/T+10 前向收益，输出：
 *   - 全样本基准胜率（对照线：什么都不触发时 T+5 涨概率）
 *   - 各子信号触发次数 / 胜率 / 均值
 *   - 巨量见顶按量比分桶、第二波按第一波倍数分桶、放量离场按量比分桶的胜率曲线
 *
 * 不写任何表（默认）；加 --write 时把触发样本落库 alert_rule_triggers(source=replay, 带触发参数)，
 * 供健康监控/周回顾立刻有历史数据。结论用于决定：值不值得建正式回测回路 + 系数扫描。
 *
 * 用法: npx tsx scripts/explore-alert-rules.ts [--days=500] [--stocks=800] [--write]
 */

import { prisma } from '../lib/db';
import { checkAllRules, ALERT_RULES } from '../services/alertRules';
import type { KLineData } from '../types';

const DAYS = parseInt(process.argv.find((a) => a.startsWith('--days='))?.split('=')[1] || '500');
const MAX_STOCKS = parseInt(process.argv.find((a) => a.startsWith('--stocks='))?.split('=')[1] || '800');
const WRITE = process.argv.includes('--write');

interface Acc { n: number; t5s: number[]; t10s: number[] }
const newAcc = (): Acc => ({ n: 0, t5s: [], t10s: [] });
const push = (map: Map<string, Acc>, k: string, t5: number, t10: number) => {
  let a = map.get(k);
  if (!a) { a = newAcc(); map.set(k, a); }
  a.n++; a.t5s.push(t5); a.t10s.push(t10);
};

const winRate = (xs: number[]) => (xs.length ? Math.round((xs.filter((x) => x > 0).length / xs.length) * 1000) / 10 : null);
const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);

const avgVol = (win: KLineData[], period: number) => {
  const s = win.slice(-period);
  if (s.length < period) return 0;
  return s.reduce((a, k) => a + k.volume, 0) / period;
};

function fmt(k: string, a: Acc) {
  return `${k.padEnd(10)} 触发${String(a.n).padStart(5)}次  T+5胜率${String(winRate(a.t5s)).padStart(5)}%  T+5均值${String(mean(a.t5s)).padStart(6)}%  T+10胜率${String(winRate(a.t10s)).padStart(5)}%`;
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
  const days = await prisma.dailyBar.findMany({
    where: { tradeDate: { lte: latest.tradeDate } },
    select: { tradeDate: true },
    distinct: ['tradeDate'],
    orderBy: { tradeDate: 'desc' },
  });
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
  const labelMap = new Map<string, Acc>();
  const bucketPeak = new Map<string, Acc>();    // 巨量见顶：量比
  const bucketSecond = new Map<string, Acc>();  // 第二波见顶：第二波/第一波
  const bucketExit = new Map<string, Acc>();    // 放量离场：量比
  let baselineN = 0, baselineWin5 = 0, baselineSum5 = 0;
  const enabled = ALERT_RULES.filter((r) => r.isEnabled);
  const writeRows: { tsCode: string; stockName?: string; ruleId: string; subLabel: string; barDate: string; params: string | null; source: 'replay' }[] = [];

  let processed = 0;
  for (const [code, arr] of byStock) {
    if (arr.length < 70) continue;
    for (let i = 60; i < arr.length - 10; i++) {
      const win = arr.slice(i - 119, i + 1);
      const t5 = (arr[i + 5].close / arr[i].close - 1) * 100;
      const t10 = (arr[i + 10].close / arr[i].close - 1) * 100;
      baselineN++;
      if (t5 > 0) baselineWin5++;
      baselineSum5 += t5;

      const res = checkAllRules(win, null, enabled);
      for (const r of res) {
        if (r.ruleId !== 'R01' && r.ruleId !== 'R02') continue;
        let label = r.ruleId;
        try { label = JSON.parse(r.extraData ?? '{}').main ?? label; } catch { /* ignore */ }
        push(labelMap, label, t5, t10);

        // 分桶参数重算（收盘口径与规则内部一致：quote=null → effVol=今日全日量）
        const today = arr[i];
        let params: Record<string, number> | null = null;
        if (label === '巨量见顶') {
          const avg20 = avgVol(win, 20);
          const ratio = avg20 > 0 ? today.volume / avg20 : 0;
          params = { volRatio20: Math.round(ratio * 10) / 10 };
          const b = ratio >= 4 ? '≥4x' : ratio >= 3 ? '3-4x' : ratio >= 2.5 ? '2.5-3x' : ratio >= 2 ? '2-2.5x' : `近线${ratio.toFixed(1)}x`;
          push(bucketPeak, b, t5, t10);
        } else if (label === '第二波见顶') {
          const firstWaveMax = Math.max(...win.slice(0, -5).map((k) => k.volume));
          const secondWaveMax = Math.max(...win.slice(-5, -1).map((k) => k.volume));
          const ratio = firstWaveMax > 0 ? secondWaveMax / firstWaveMax : 0;
          params = { ratio: Math.round(ratio * 100) / 100 };
          const b = ratio >= 1.2 ? '≥1.2x' : ratio >= 1.1 ? '1.1-1.2x' : ratio >= 1.0 ? '1.0-1.1x' : '0.9-1.0x';
          push(bucketSecond, b, t5, t10);
        } else if (label === '放量离场') {
          const avg5 = avgVol(win, 5);
          const ratio = avg5 > 0 ? today.volume / avg5 : 0;
          params = { volRatio5: Math.round(ratio * 10) / 10 };
          const b = ratio >= 3.5 ? '≥3.5x' : ratio >= 2.5 ? '2.5-3.5x' : '2-2.5x';
          push(bucketExit, b, t5, t10);
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
  const allT5 = [...labelMap.values()].flatMap((a) => a.t5s);
  console.log('\n=== 基准对照（全部样本日，无条件） ===');
  console.log(`  全样本 T+5 胜率 ${Math.round((baselineWin5 / baselineN) * 1000) / 10}%  均值 ${Math.round((baselineSum5 / baselineN) * 100) / 100}%`);

  // 子信号汇总
  console.log('\n=== R01/R02 子信号触发统计（T+5/T+10 绝对收益） ===');
  const labels = [...labelMap.entries()].sort((a, b) => b[1].n - a[1].n);
  for (const [k, a] of labels) console.log(`  ${fmt(k, a)}`);

  // 分桶
  bucketReport(bucketPeak, '巨量见顶 · 按量比(今日/20日均)分桶');
  bucketReport(bucketSecond, '第二波见顶 · 按第二波/第一波比例分桶');
  bucketReport(bucketExit, '放量离场 · 按量比(今日/5日均)分桶');

  console.log('\n[explore] 说明：收盘口径重放（盘中折算退化为全日量），量能类规则样本与盘中实况有偏差；未分大盘环境。');
  await prisma.$disconnect();
}

main().catch((e) => { console.error('[explore] 失败:', e); process.exit(1); });
