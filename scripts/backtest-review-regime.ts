/**
 * 复盘日历 周期状态机（3 态）10 年回测 + 冰点前瞻收益统计（Phase 0 验证）
 * 只读 review_calendar_days + index_daily 小表，不碰 daily_bars。
 * 用法：
 *   npx tsx scripts/backtest-review-regime.ts [--hysteresis N] [--dump YYYYMM]
 * 状态：0=defense(收缩) 1=neutral(震荡) 2=attack(活跃)，仅相邻跳转。
 */

import { prisma } from "../lib/db";

interface Day {
  trade_date: string;
  total_amount: number | null;
  advance: number; decline: number;
  volume_ratio: number | null;
  idx_pct_chg: number | null;
  ice_level: string | null;
}

const N = (() => { const i = process.argv.indexOf("--hysteresis"); return i >= 0 && process.argv[i + 1] ? parseInt(process.argv[i + 1], 10) : 2; })();
const r2 = (x: number | null | undefined, d = 4) => (x == null || !Number.isFinite(x) ? "--" : Number(x).toFixed(d));
const pct = (x: number | null | undefined, d = 2) => (x == null || !Number.isFinite(x) ? "--" : (x * 100).toFixed(d) + "%");
const NAME = ["defense", "neutral", "attack"];

// 单日三分类：活跃=量能放大且涨家数占优；收缩=量能萎缩/涨家数极低/指数大跌
function classify(vr: number | null, upRatio: number | null, idxPct: number | null): number {
  if (vr != null && upRatio != null && vr >= 1.0 && upRatio >= 0.55) return 2;
  if (vr != null && vr <= 0.85) return 0;
  if (upRatio != null && upRatio <= 0.35) return 0;
  if (idxPct != null && idxPct <= -2) return 0;
  return 1;
}

// 强确认（当日立即切换，不等滞回窗口）
function strongAttack(vr: number | null, upRatio: number | null): boolean {
  return vr != null && upRatio != null && vr >= 1.2 && upRatio >= 0.55;
}
function strongDefense(vr: number | null, upRatio: number | null, idxPct: number | null): boolean {
  if (idxPct != null && idxPct <= -2.5) return true;
  if (vr != null && vr <= 0.7) return true;
  if (upRatio != null && upRatio <= 0.2) return true;
  return false;
}

function clampStep(cur: number, cand: number): number {
  if (Math.abs(cand - cur) <= 1) return cand;
  return cur + (cand > cur ? 1 : -1);
}

async function main() {
  const days = await prisma.$queryRawUnsafe<Day[]>("SELECT trade_date, total_amount, advance, decline, volume_ratio, idx_pct_chg, ice_level FROM review_calendar_days ORDER BY trade_date");
  const closes = await prisma.$queryRawUnsafe<{ trade_date: string; close: number | null }[]>("SELECT trade_date, close FROM index_daily WHERE ts_code = '000001.SH' ORDER BY trade_date");

  const closesArr = closes.filter((r) => r.close != null).map((r) => r.close as number);
  const datesArr = closes.filter((r) => r.close != null).map((r) => r.trade_date);
  const closeIdx = new Map(datesArr.map((d, i) => [d, i]));

  // 状态机
  const states: Record<string, number> = {};
  let cur = 1; // 从 neutral 起
  let atkStreak = 0, defStreak = 0;
  const stateSeq: number[] = [];
  for (const d of days) {
    const up = d.advance + d.decline;
    const upRatio = up > 0 ? d.advance / up : null;
    const c = classify(d.volume_ratio, upRatio, d.idx_pct_chg);
    atkStreak = c === 2 ? atkStreak + 1 : 0;
    defStreak = c === 0 ? defStreak + 1 : 0;
    let cand: number;
    if (strongAttack(d.volume_ratio, upRatio)) cand = 2;
    else if (strongDefense(d.volume_ratio, upRatio, d.idx_pct_chg)) cand = 0;
    else if (atkStreak >= N) cand = 2;
    else if (defStreak >= N) cand = 0;
    else if (c === 1) cand = 1;
    else cand = cur; // 粘滞：方向未持续 N 日，维持原状
    cur = clampStep(cur, cand);
    states[d.trade_date] = cur;
    stateSeq.push(cur);
  }

  // 状态分布与切换频率
  const dist: Record<string, number> = {};
  let switches = 0;
  for (let i = 0; i < stateSeq.length; i++) {
    const k = NAME[stateSeq[i]];
    dist[k] = (dist[k] || 0) + 1;
    if (i > 0 && stateSeq[i] !== stateSeq[i - 1]) switches++;
  }
  console.log("=== 状态分布 (hysteresis=" + N + ") ===");
  for (const [k, v] of Object.entries(dist)) console.log("  " + k + " " + v + " 天 (" + (v / stateSeq.length * 100).toFixed(1) + "%)");
  console.log("切换次数 " + switches + "，平均每 " + (stateSeq.length / Math.max(1, switches)).toFixed(1) + " 交易日切换一次");

  const fwd = [1, 5, 20];
  const agg: Record<string, Record<string, number[]>> = {};
  const iceAgg: Record<string, Record<string, number[]>> = {};
  for (const d of days) {
    const i = closeIdx.get(d.trade_date);
    if (i == null) continue;
    for (const n of fwd) {
      const j = i + n;
      if (j >= closesArr.length) continue;
      const ret = closesArr[j] / closesArr[i] - 1;
      const key = String(n) + "d";
      const st = NAME[states[d.trade_date]];
      (agg[st] = agg[st] || {})[key] = (agg[st][key] || []);
      agg[st][key].push(ret);
      const ice = d.ice_level || "无";
      (iceAgg[ice] = iceAgg[ice] || {})[key] = (iceAgg[ice][key] || []);
      iceAgg[ice][key].push(ret);
    }
  }

  const stats = (arr: number[]) => {
    if (!arr.length) return { n: 0, mean: "--", med: "--", win: "--" };
    const sorted = [...arr].sort((a, b) => a - b);
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const med = sorted[Math.floor(sorted.length / 2)];
    const win = arr.filter((x) => x > 0).length / arr.length;
    return { n: arr.length, mean: pct(mean), med: pct(med), win: pct(win) };
  };

  console.log("\n=== 周期状态 → 其后 1/5/20 日上证收益 ===");
  for (const st of ["attack", "neutral", "defense"]) {
    if (!agg[st]) continue;
    console.log("[" + st + "]");
    for (const n of fwd) {
      const s = stats(agg[st][String(n) + "d"] || []);
      console.log("  其后 " + n + " 日: n=" + s.n + " 均值=" + s.mean + " 中位=" + s.med + " 胜率=" + s.win);
    }
  }

  console.log("\n=== 冰点等级 → 其后 1/5/20 日上证收益 ===");
  for (const ice of ["极冰", "接近冰点", "偏冷", "无"]) {
    if (!iceAgg[ice]) continue;
    console.log("[" + ice + "]");
    for (const n of fwd) {
      const s = stats(iceAgg[ice][String(n) + "d"] || []);
      console.log("  其后 " + n + " 日: n=" + s.n + " 均值=" + s.mean + " 中位=" + s.med + " 胜率=" + s.win);
    }
  }

  console.log("\n=== 阈值敏感性（冰点=量能比<X，看其后 5 日上证胜率/均值） ===");
  for (let x = 0.72; x <= 0.88; x += 0.02) {
    const arr: number[] = [];
    for (const d of days) {
      if (d.volume_ratio != null && d.volume_ratio < x) {
        const i = closeIdx.get(d.trade_date);
        if (i != null && i + 5 < closesArr.length) arr.push(closesArr[i + 5] / closesArr[i] - 1);
      }
    }
    const s = stats(arr);
    console.log("  阈值<" + x.toFixed(2) + ": n=" + s.n + " 5日均值=" + s.mean + " 胜率=" + s.win);
  }

  const dumpIdx = process.argv.indexOf("--dump");
  if (dumpIdx >= 0 && process.argv[dumpIdx + 1]) {
    const ym = process.argv[dumpIdx + 1];
    console.log("\n=== 逐日抽检 " + ym + " ===  date  state  vr  idx%  ice");
    for (const d of days) {
      if (d.trade_date.startsWith(ym)) {
        console.log("  " + d.trade_date + "  " + NAME[states[d.trade_date]] + "  " + r2(d.volume_ratio) + "  " + r2(d.idx_pct_chg) + "  " + (d.ice_level || "-"));
      }
    }
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[backtest-regime] 失败:", e.message);
  await prisma.$disconnect();
  process.exit(1);
});
