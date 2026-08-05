/**
 * 筹码分布（筹码峰）单一事实源 —— 路线 B 换手率转移模型
 *
 * 算法（陈浩《筹码分布》）：
 *   - 价格桶等分 [minLow, maxHigh]
 *   - 逐日 oldest→newest：旧筹码按 (1 − turnoverRate) 衰减，当日新筹码按 [low,high] 三角分布（峰在 close）撒入桶
 *   - 缺 turnover_rate 的历史行降级为固定衰减 γ=0.97（路线 A 混合），保证回填未完成时不报错
 *   - totalShares 标量归一化掉（设相对单位），峰形/获利盘/集中度 scale-invariant
 *
 * 派生 4 子维度（AI 筛选 chip 因子 + R13/R14 预警用）：
 *   concentration90 / profitRatio / peakPos / peakDrift
 *
 * 数据从 DB daily_bars（含 turnover_rate）取，不走实时 K 线（实时路径无换手率）。
 */

import { prisma } from "@/lib/db";
import { toTsCode } from "@/lib/tushare";

export interface ChipBar {
  high: number;
  low: number;
  close: number;
  vol: number;
  turnoverRate: number | null; // %，NULL 触发固定衰减降级
}

export interface ChipDistribution {
  dominantPeak: number;        // 主峰价位
  avgCost: number;             // 加权平均成本
  concentration90: number;     // (P95 − P5) / avgCost，越小越密集
  profitRatio: number;         // 当前价下方筹码占比 0-1
  peakPos: number;             // (currentPrice − dominantPeak) / avgCost，站上主峰为正
  peakDrift: number;           // (主峰今 − 主峰5日前) / avgCost，上移为正(派发)，下移为负(吸筹)
  peaks: number[];             // 局部极大峰价位列表
  currentPrice: number;
  /** 价格桶密度（升序价位），供可视化/调试用 */
  dist: { price: number; weight: number }[];
}

const BIN_COUNT = 120;
const FIXED_DECAY = 0.97; // turnover_rate 缺失时的降级衰减因子

/** 三角分布权重：[low, high] 区间，峰在 close */
function triangleWeight(p: number, low: number, high: number, close: number): number {
  if (high <= low) return 1; // 一字板，全压在一个价位
  const c = Math.min(Math.max(close, low), high);
  if (p < low || p > high) return 0;
  if (p <= c) {
    const denom = c - low;
    return denom <= 0 ? 1 : (p - low) / denom;
  }
  const denom = high - c;
  return denom <= 0 ? 1 : (high - p) / denom;
}

/**
 * 纯函数：计算筹码分布。bars 按日期升序（最旧在前）。
 * 返回 null 表示数据不足。
 */
export function computeChipDistribution(bars: ChipBar[], currentPrice: number): ChipDistribution | null {
  const valid = bars.filter(b => b.high != null && b.low != null && b.close != null && b.high > 0);
  if (valid.length < 5 || !currentPrice || currentPrice <= 0) return null;

  let minLow = Infinity;
  let maxHigh = -Infinity;
  for (const b of valid) {
    if (b.low < minLow) minLow = b.low;
    if (b.high > maxHigh) maxHigh = b.high;
  }
  if (maxHigh <= minLow) {
    // 整个窗口一字板，单一价位
    const price = valid[valid.length - 1].close;
    return {
      dominantPeak: price, avgCost: price, concentration90: 0,
      profitRatio: currentPrice >= price ? 1 : 0, peakPos: (currentPrice - price) / price,
      peakDrift: 0, peaks: [price], currentPrice, dist: [{ price, weight: 1 }],
    };
  }

  const binWidth = (maxHigh - minLow) / BIN_COUNT;
  const binPrice = (i: number) => minLow + (i + 0.5) * binWidth;
  const dist = new Array(BIN_COUNT).fill(0);

  for (const b of valid) {
    const t = b.turnoverRate != null && b.turnoverRate > 0 && b.turnoverRate < 100
      ? b.turnoverRate / 100
      : null;
    const decay = t != null ? (1 - t) : FIXED_DECAY;
    const newFrac = t != null ? t : (1 - FIXED_DECAY);

    // 旧筹码衰减
    for (let i = 0; i < BIN_COUNT; i++) dist[i] *= decay;

    // 当日新筹码按三角分布撒入
    let rawSum = 0;
    const raw = new Array(BIN_COUNT).fill(0);
    for (let i = 0; i < BIN_COUNT; i++) {
      const p = binPrice(i);
      const w = triangleWeight(p, b.low, b.high, b.close);
      raw[i] = w;
      rawSum += w;
    }
    if (rawSum > 0) {
      for (let i = 0; i < BIN_COUNT; i++) dist[i] += newFrac * (raw[i] / rawSum);
    }
  }

  const total = dist.reduce((s, v) => s + v, 0);
  if (total <= 0) return null;

  // 主峰
  let peakIdx = 0;
  for (let i = 1; i < BIN_COUNT; i++) if (dist[i] > dist[peakIdx]) peakIdx = i;
  const dominantPeak = binPrice(peakIdx);

  // 平均成本
  let avgCost = 0;
  for (let i = 0; i < BIN_COUNT; i++) avgCost += binPrice(i) * dist[i];
  avgCost /= total;
  if (avgCost <= 0) return null;

  // 获利盘比例（当前价下方累计）
  let below = 0;
  for (let i = 0; i < BIN_COUNT; i++) {
    if (binPrice(i) <= currentPrice) below += dist[i];
  }
  const profitRatio = below / total;

  // 90% 集中度（P5 ~ P95 区间宽度 / avgCost）
  let acc = 0;
  let p5 = minLow, p95 = maxHigh;
  let p5Found = false, p95Found = false;
  for (let i = 0; i < BIN_COUNT; i++) {
    acc += dist[i];
    if (!p5Found && acc >= 0.05 * total) { p5 = binPrice(i); p5Found = true; }
    if (!p95Found && acc >= 0.95 * total) { p95 = binPrice(i); p95Found = true; }
  }
  const concentration90 = (p95 - p5) / avgCost;

  // 局部极大峰
  const peaks: number[] = [];
  const peakThresh = dist[peakIdx] * 0.3;
  for (let i = 1; i < BIN_COUNT - 1; i++) {
    if (dist[i] >= peakThresh && dist[i] >= dist[i - 1] && dist[i] >= dist[i + 1] && dist[i] > 0) {
      peaks.push(Math.round(binPrice(i) * 100) / 100);
    }
  }

  return {
    dominantPeak: Math.round(dominantPeak * 100) / 100,
    avgCost: Math.round(avgCost * 100) / 100,
    concentration90: Math.round(concentration90 * 1000) / 1000,
    profitRatio: Math.round(profitRatio * 1000) / 1000,
    peakPos: Math.round(((currentPrice - dominantPeak) / avgCost) * 1000) / 1000,
    peakDrift: 0, // 由 getChipDistribution 二次计算填入
    peaks,
    currentPrice,
    dist: dist.map((w, i) => ({ price: Math.round(binPrice(i) * 100) / 100, weight: w })),
  };
}

interface DbBar { high: number | null; low: number | null; close: number | null; vol: number | null; turnover_rate: number | null }

/**
 * 从 DB 取数计算筹码分布。code 接受 sh600519 / 000001 / 000001.SZ 等任意格式。
 * 多取 5 根用于 peakDrift 偏移窗口对比。
 */
export async function getChipDistribution(code: string, days = 90): Promise<ChipDistribution | null> {
  const tsCode = toTsCode(code);
  const fetch = days + 5;
  const rows: DbBar[] = await prisma.$queryRawUnsafe(
    `SELECT high, low, close, vol, turnover_rate
     FROM daily_bars
     WHERE "tsCode" = $1 AND high IS NOT NULL AND close IS NOT NULL
     ORDER BY "tradeDate" DESC
     LIMIT $2`,
    tsCode, fetch
  );
  if (rows.length < 5) return null;

  // DESC 取回 → 反转成升序
  const asc = rows.slice().reverse();
  const bars: ChipBar[] = asc.map(r => ({
    high: r.high!, low: r.low!, close: r.close!, vol: r.vol ?? 0, turnoverRate: r.turnover_rate,
  }));
  const currentPrice = bars[bars.length - 1].close;

  // 主窗口：最近 days 根
  const mainBars = bars.slice(Math.max(0, bars.length - days));
  const dist = computeChipDistribution(mainBars, currentPrice);
  if (!dist) return null;

  // peakDrift：与 5 日前窗口的主峰对比
  if (bars.length > days + 5 && bars.length >= 10) {
    const prevBars = bars.slice(Math.max(0, bars.length - days - 5), bars.length - 5);
    const prevPrice = prevBars[prevBars.length - 1]?.close ?? currentPrice;
    const prevDist = computeChipDistribution(prevBars, prevPrice);
    if (prevDist) {
      dist.peakDrift = Math.round(((dist.dominantPeak - prevDist.dominantPeak) / dist.avgCost) * 1000) / 1000;
    }
  }

  return dist;
}

/** 形态描述（供 AI 解读 / 弱提醒文案） */
export function describeChipShape(chip: ChipDistribution): string {
  const parts: string[] = [];
  if (chip.concentration90 < 0.12) parts.push("高度单峰密集");
  else if (chip.concentration90 < 0.18) parts.push("筹码较密集");
  else parts.push("筹码分散");

  if (chip.profitRatio > 0.7 && chip.peakPos >= 0) parts.push("低位密集（主力成本在下方）");
  else if (chip.profitRatio < 0.4 && chip.peakPos < 0) parts.push("高位套牢（上方压力大）");

  if (chip.peakDrift > 0.03) parts.push("峰位上移（疑似派发）");
  else if (chip.peakDrift < -0.03) parts.push("峰位下移（疑似吸筹）");

  return parts.join("，") || "形态中性";
}

/** 摘要文本（注入 AI prompt / 对话工具返回） */
export function formatChipSummary(chip: ChipDistribution): string {
  return [
    `主峰价位: ${chip.dominantPeak}`,
    `平均成本: ${chip.avgCost}`,
    `获利盘比例: ${(chip.profitRatio * 100).toFixed(1)}%`,
    `90%集中度: ${chip.concentration90.toFixed(3)}（越小越密集）`,
    `峰位相对位置: ${chip.peakPos.toFixed(3)}（站上主峰为正）`,
    `5日峰位漂移: ${chip.peakDrift.toFixed(3)}（下移为吸筹）`,
    `形态: ${describeChipShape(chip)}`,
  ].join("\n");
}
