import { readFileSync } from 'fs';

/**
 * 龙首阴参数扫描（离线）
 * 读取 10 年明细 JSON，做贪心单变量搜索。
 * 目标：次日最高价 >= +2% 的概率最大（用户确认）。
 * 用法：npx tsx scripts/tune-dragon-first-yin.ts --file ./dragon-first-yin-detail.json
 */

interface DetailRow {
  boardCount: number;
  quality: string;
  changeCount: number;
  oneWordCount: number;
  trailingOneWordStreak: number;
  minChangeBoardTurnover: number | null;
  bodyPct: number;
  changePct: number;
  volumeRatio: number;
  turnoverRate: number | null;
  atLimitDown: boolean;
  isHighBoard: boolean;
  retOpen: number;
  retCloseHigh: number;
  retBoardHigh: number | null;
}

interface Params {
  maxVolumeRatio: number;
  maxYinTurnoverRate: number;
  yinBodyMaxPct: number;
  minTurnoverRate: number;
  oneWordMode: 'allow' | 'excludeAllOneWord';
}

const MIN_N = 30;

function round(n: number, d = 2): number {
  const p = Math.pow(10, d);
  return Math.round(n * p) / p;
}

function mean(arr: number[]): number {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function metrics(rows: DetailRow[]) {
  const n = rows.length;
  const high = rows.map((r) => r.retCloseHigh);
  return {
    n,
    reach2: n ? rows.filter((r) => r.retCloseHigh >= 2).length / n : 0,
    reach3: n ? rows.filter((r) => r.retCloseHigh >= 3).length / n : 0,
    avgHigh: mean(high),
    winHigh: n ? rows.filter((r) => r.retCloseHigh > 0).length / n : 0,
    avgOpen: mean(rows.map((r) => r.retOpen)),
  };
}

function applyFilters(rows: DetailRow[], p: Params): DetailRow[] {
  return rows.filter((r) => {
    if (r.volumeRatio > p.maxVolumeRatio) return false;
    if (r.turnoverRate != null && r.turnoverRate > p.maxYinTurnoverRate) return false;
    if (r.bodyPct > p.yinBodyMaxPct) return false;
    if (r.atLimitDown) return false;
    if (p.minTurnoverRate > 0) {
      if (r.minChangeBoardTurnover == null || r.minChangeBoardTurnover < p.minTurnoverRate) return false;
    }
    if (p.oneWordMode === 'excludeAllOneWord' && r.quality === 'oneWord') return false;
    return true;
  });
}

function choose(rows: DetailRow[], current: Params, key: keyof Params, values: any[]): { value: any; m: ReturnType<typeof metrics> } {
  let bestValue = current[key];
  let bestM: ReturnType<typeof metrics> | null = null;
  for (const v of values) {
    const cand = { ...current, [key]: v } as Params;
    const filtered = applyFilters(rows, cand);
    const m = metrics(filtered);
    if (m.n < MIN_N) continue;
    if (!bestM || m.reach2 > bestM.reach2 || (Math.abs(m.reach2 - bestM.reach2) < 1e-9 && m.avgHigh > bestM.avgHigh)) {
      bestValue = v;
      bestM = m;
    }
  }
  return { value: bestValue, m: bestM ?? metrics(applyFilters(rows, current)) };
}

async function main() {
  const arg = (key: string) => {
    const i = process.argv.indexOf(key);
    return i >= 0 ? process.argv[i + 1] : null;
  };
  const file = arg('--file') ?? './dragon-first-yin-detail.json';
  const all: DetailRow[] = JSON.parse(readFileSync(file, 'utf8'));

  const baseline: Params = {
    maxVolumeRatio: 3.0,
    maxYinTurnoverRate: 45,
    yinBodyMaxPct: 7,
    minTurnoverRate: 0,
    oneWordMode: 'allow',
  };
  const baseM = metrics(applyFilters(all, baseline));
  console.log('baseline', JSON.stringify({ params: baseline, metrics: baseM }, null, 2));

  let current = { ...baseline };
  const steps: any[] = [];
  for (let round = 0; round < 2; round++) {
    const picks: any[] = [];
    for (const key of ['maxVolumeRatio', 'maxYinTurnoverRate', 'yinBodyMaxPct', 'minTurnoverRate', 'oneWordMode'] as (keyof Params)[]) {
      const values = key === 'maxVolumeRatio' ? [2.0, 2.5, 3.0, 3.5, 4.0]
        : key === 'maxYinTurnoverRate' ? [30, 40, 45, 50, 60]
        : key === 'yinBodyMaxPct' ? [5, 6, 7, 8, 9]
        : key === 'minTurnoverRate' ? [0, 3, 5, 8, 10]
        : ['allow', 'excludeAllOneWord'];
      const chosen = choose(all, current, key, values);
      current = { ...current, [key]: chosen.value } as Params;
      picks.push({ key, value: chosen.value, metrics: chosen.m });
    }
    steps.push({ round: round + 1, picks });
  }

  const finalM = metrics(applyFilters(all, current));
  console.log('final', JSON.stringify({ params: current, metrics: finalM, baseline: baseM, steps }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
