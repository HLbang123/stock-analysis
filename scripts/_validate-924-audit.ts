/**
 * 校验：backtest-shortterm-924-audit.ts 的「宽松检测 + 离线变体」是否等价于生产引擎默认 config。
 *
 * 对每个策略，在同年同一批 bar 上分别统计：
 *   A = 生产 DEFAULT config 直接检测命中数
 *   B = 宽松 config 检测命中 + base 变体谓词过滤后的命中数
 * A 与 B 必须逐条一致（按 code|date 集合比较），否则 audit 结论不成立。
 *
 * 用法：npx tsx scripts/_validate-924-audit.ts [--year=2024]
 */

import { prisma } from '../lib/db';
import { detectLimitUpThreeYinAt, DEFAULT_LIMIT_UP_THREE_YIN_CONFIG, ThreeYinBar } from '../lib/strategy/limit-up-three-yin';
import { detectDragonFirstYinAt, DEFAULT_DRAGON_FIRST_YIN_CONFIG, DragonBar } from '../lib/strategy/dragon-first-yin';
import { detectDoubleDragonBoard, DEFAULT_DOUBLE_DRAGON_CONFIG, DoubleDragonBar } from '../lib/strategy/double-dragon';
import { detectDragonFourYinAt, DEFAULT_DRAGON_FOUR_YIN_CONFIG, DragonFourYinBar } from '../lib/strategy/dragon-four-yin';

interface RawBar {
  tsCode: string; tradeDate: string; open: number | null; high: number | null; low: number | null;
  close: number | null; preClose: number | null; vol: number | null; turnoverRate: number | null;
}
interface Bar {
  date: string; open: number; high: number; low: number; close: number; volume: number;
  preClose: number | null; turnoverRate: number | null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const fmtDate = (d: string): string => (d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d);

function isLuAt(bars: Bar[], k: number): boolean {
  if (k < 0 || k >= bars.length) return false;
  const b = bars[k];
  const prev = b.preClose != null && b.preClose > 0 ? b.preClose : k > 0 ? bars[k - 1].close : null;
  if (prev == null || prev <= 0) return false;
  const lim = round2(prev * 1.1);
  return Math.abs(b.close - lim) <= 0.011 && b.high >= lim - 0.011;
}
function avgVol(bars: Bar[], from: number, to: number): number {
  let s = 0, c = 0;
  for (let j = from; j < to; j++) if (j >= 0) { s += bars[j].volume; c++; }
  return c > 0 ? s / c : 0;
}

function loadCandidateCodes(start: string, end: string): Promise<{ tsCode: string }[]> {
  const sql = [
    'SELECT DISTINCT b."tsCode" AS "tsCode"',
    'FROM daily_bars b',
    'JOIN stocks s ON s.ts_code = b."tsCode"',
    'WHERE b."tradeDate" >= $1 AND b."tradeDate" <= $2',
    '  AND s.is_active = true',
    "  AND s.ts_code ~ '^(600|601|603|605|000|001|002|003)'",
    "  AND s.name !~ '(ST|退)'",
    '  AND (b.change_pct >= 9.5 OR (b.pre_close > 0 AND b.close >= b.pre_close * 1.095 AND b.high >= b.pre_close * 1.095))',
  ].join('\n');
  return prisma.$queryRawUnsafe<{ tsCode: string }[]>(sql, start, end);
}
function loadBars(codes: string[], start: string, end: string): Promise<RawBar[]> {
  if (!codes.length) return Promise.resolve([]);
  const sql = [
    'SELECT b."tsCode" AS "tsCode", b."tradeDate" AS "tradeDate",',
    '       b.open, b.high, b.low, b.close, b.pre_close AS "preClose", b.vol,',
    '       b.turnover_rate AS "turnoverRate"',
    'FROM daily_bars b',
    'WHERE b."tsCode" = ANY($1)',
    '  AND b."tradeDate" >= $2 AND b."tradeDate" <= $3',
  ].join('\n');
  return prisma.$queryRawUnsafe<RawBar[]>(sql, codes, start, end);
}

async function main(): Promise<void> {
  const year = (process.argv.find((a) => a.startsWith('--year=')) ?? '--year=2024').slice('--year='.length);
  const start = `${Number(year) - 1}0901`;
  const end = `${Number(year) + 1}0110`;
  const codes = (await loadCandidateCodes(start, end)).map((r) => r.tsCode);
  const raw = await loadBars(codes, start, end);
  const byCode = new Map<string, RawBar[]>();
  for (const r of raw) {
    if (r.open == null || r.close == null || r.high == null || r.low == null) continue;
    if (!byCode.has(r.tsCode)) byCode.set(r.tsCode, []);
    byCode.get(r.tsCode)!.push(r);
  }

  const prod = new Map<string, Set<string>>();
  const mine = new Map<string, Set<string>>();
  for (const k of ['sy', 'dfy', 'ddBoard', 'd4']) {
    prod.set(k, new Set()); mine.set(k, new Set());
  }
  const add = (m: Map<string, Set<string>>, k: string, code: string, date: string) => m.get(k)!.add(code + '|' + date);

  for (const [code, rawBars] of byCode) {
    rawBars.sort((a, b) => (a.tradeDate < b.tradeDate ? -1 : 1));
    const bars: Bar[] = rawBars.map((r) => ({
      date: fmtDate(r.tradeDate), open: Number(r.open), high: Number(r.high), low: Number(r.low),
      close: Number(r.close), volume: Number(r.vol ?? 0),
      preClose: r.preClose != null ? Number(r.preClose) : null,
      turnoverRate: r.turnoverRate != null ? Number(r.turnoverRate) : null,
    }));
    if (bars.length < 70) continue;

    for (let i = 3; i < bars.length; i++) {
      if (bars[i].date.slice(0, 4) !== year) continue;
      if (!(bars[i].close < bars[i].open && bars[i - 1].close < bars[i - 1].open && bars[i - 2].close < bars[i - 2].open)) continue;
      if (!isLuAt(bars, i - 3)) continue;
      const p = detectLimitUpThreeYinAt(bars as ThreeYinBar[], i, {});
      if (p.matched) add(prod, 'sy', code, p.metrics.entryClose > 0 ? bars[i].date : bars[i].date);
      const s = detectLimitUpThreeYinAt(bars as ThreeYinBar[], i, { minYinBodyPct: 0, maxYinBodyPct: 1e9, requireTrueYin: false });
      if (s.matched) {
        const minBody = Math.min(...s.metrics.yinBodies);
        const maxBody = Math.max(...s.metrics.yinBodies);
        const ok = minBody >= 0.05 && maxBody <= 6.0
          && bars[i - 1].close < bars[i - 2].close && bars[i].close < bars[i - 1].close;
        if (ok) add(mine, 'sy', code, bars[i].date);
      }
    }

    for (let i = 1; i < bars.length; i++) {
      if (bars[i].date.slice(0, 4) !== year) continue;
      if (!isLuAt(bars, i - 1)) continue;
      const p = detectDragonFirstYinAt(bars as DragonBar[], i, {});
      if (p.matched) add(prod, 'dfy', code, bars[i].date);
      const s = detectDragonFirstYinAt(bars as DragonBar[], i, {
        minTurnoverRate: 0, yinBodyMaxPct: 1e9, maxVolumeRatio: 1e9, maxYinTurnoverRate: 1e9,
        requireFakeYinAtHighBoards: false, rejectLimitDownYin: false, skipAllOneWordRun: false,
      });
      if (s.matched && s.run && s.yin) {
        const run = s.run, yin = s.yin;
        const changeBoards = run.boards.filter((b) => !b.oneWord);
        const changeTurnovers = changeBoards.map((b) => b.turnoverRate).filter((x): x is number => x != null);
        const maxChangeTurnover = changeTurnovers.length ? Math.max(...changeTurnovers) : -Infinity;
        const ok = run.boardCount >= 3 && maxChangeTurnover >= 8 && yin.bodyPct <= 7
          && yin.volumeRatio <= 2.5 && (yin.turnoverRate == null || yin.turnoverRate <= 45)
          && !yin.atLimitDown && (run.boardCount < 5 || yin.fakeYin || yin.isWash);
        if (ok) add(mine, 'dfy', code, bars[i].date);
      }
    }

    for (let i = 2; i < bars.length; i++) {
      if (bars[i].date.slice(0, 4) !== year) continue;
      if (!(isLuAt(bars, i - 1) && isLuAt(bars, i))) continue;
      const p = detectDoubleDragonBoard(bars as DoubleDragonBar[], i, {});
      if (p.matched) add(prod, 'ddBoard', code, p.entryDate);
      const s = detectDoubleDragonBoard(bars as DoubleDragonBar[], i, {});
      if (s.matched) add(mine, 'ddBoard', code, s.entryDate);

      // 【2026-09-11 已删除】双龙回踩对照分支（该买入方式已从策略体系移除）
    }

    for (let i = 4; i < bars.length; i++) {
      if (bars[i].date.slice(0, 4) !== year) continue;
      if (!(bars[i].close < bars[i].open && bars[i - 1].close < bars[i - 1].open
        && bars[i - 2].close < bars[i - 2].open && bars[i - 3].close < bars[i - 3].open)) continue;
      if (!isLuAt(bars, i - 4)) continue;
      const p = detectDragonFourYinAt(bars as DragonFourYinBar[], i, {});
      if (p.matched) add(prod, 'd4', code, p.entryDate);
      const s = detectDragonFourYinAt(bars as DragonFourYinBar[], i, { minVolRatio: 0, nearHighRatio: 0, minBodyPct: 0, maxBodyPct: 1e9 });
      if (s.matched) {
        const b0 = bars[i - 4];
        let vsum = 0, vcnt = 0;
        for (let j = i - 4 - 10; j < i - 4; j++) if (j >= 0) { vsum += bars[j].volume; vcnt++; }
        const volRatio = vcnt > 0 ? b0.volume / (vsum / vcnt) : 0;
        let mx = 0;
        for (let j = Math.max(0, i - 4 - 20); j < i - 4; j++) mx = Math.max(mx, bars[j].high);
        const nearHighPct = mx > 0 ? (b0.close / mx) * 100 : 0;
        const body1 = b0.open > 0 ? ((bars[i - 3].open - bars[i - 3].close) / bars[i - 3].open) * 100 : 0;
        const ok = volRatio >= 1.5 && nearHighPct >= 95 && body1 >= 0.05 && body1 <= 8;
        if (ok) add(mine, 'd4', code, s.entryDate);
      }
    }
  }

  const names: Record<string, string> = { sy: '板三阴', dfy: '龙首阴', ddBoard: '双龙打板', d4: '龙四阴' };
  let bad = 0;
  for (const k of ['sy', 'dfy', 'ddBoard', 'd4']) {
    const P = prod.get(k)!, M = mine.get(k)!;
    const onlyProd = [...P].filter((x) => !M.has(x));
    const onlyMine = [...M].filter((x) => !P.has(x));
    const ok = onlyProd.length === 0 && onlyMine.length === 0;
    if (!ok) bad++;
    console.log(`${names[k].padEnd(6)} prod=${P.size} mine=${M.size} ${ok ? 'MATCH' : 'MISMATCH'}` +
      (onlyProd.length ? ` onlyProd=${onlyProd.slice(0, 5).join(',')}` : '') +
      (onlyMine.length ? ` onlyMine=${onlyMine.slice(0, 5).join(',')}` : ''));
  }
  console.log(bad === 0 ? '\nALL MATCH ✅' : `\n${bad} MISMATCH ❌`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
