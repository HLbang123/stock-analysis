/**
 * 仙人指路 — 低位类因子「落盘」脚本（供离线交叉验证）
 *
 * 目的：判断 MACD 象限 / MA60 位置 / 60日线斜率 / 距高点回撤 / 距低点涨幅 这些「低位代理」，
 *   在**控制住 gain60 之后**是否还有独立增量；反过来也看 gain60 在控制住 MACD 后是否还成立。
 *
 * 做法：一次扫描把所有信号的全部因子值落成 JSON（/tmp），交叉分析在本地跑
 *   （scripts/analyze-xianren-lowpos.ts，无需 DB），可反复迭代而不用重跑回测。
 *
 * 口径：主板非 ST、原始价、生产 DEFAULT_XIANREN_CONFIG（含确认日缩量≤1.0）；
 *   2022~2026、剔 924；收益 = T+1 当日最高 / T+5 累计最高（相对确认日收盘）。
 *
 * 用法：
 *   npx tsx scripts/backtest-xianren-lowpos-dump.ts --selftest
 *   npx tsx scripts/backtest-xianren-lowpos-dump.ts --out=/tmp/xr-lowpos.json
 */

import { writeFileSync } from 'fs';
import { prisma } from '../lib/db';
import { detectXianRenAt, computeMacdQuadAt, DEFAULT_XIANREN_CONFIG, XianRenBar } from '../lib/strategy/xian-ren-zhi-lu';

interface RawBar {
  tsCode: string;
  tradeDate: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  preClose: number | null;
  vol: number | null;
  turnoverRate: number | null;
  circMv: number | null;
  name: string | null;
}

interface Bar {
  date: string;
  open: number; high: number; low: number; close: number;
  volume: number;
  preClose: number | null;
  turnoverRate: number | null;
}

const YEARS = ['2022', '2023', '2024', '2025', '2026'];
const EX_LO = '2024-09-24';
const EX_HI = '2024-10-08';

const round = (n: number, d = 3): number => {
  const p = Math.pow(10, d);
  return Math.round(n * p) / p;
};
const fmtDate = (d: string): string =>
  d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d;

function loadBars(start: string, end: string): Promise<RawBar[]> {
  const sql = [
    'SELECT b."tsCode" AS "tsCode", b."tradeDate" AS "tradeDate",',
    '       b.open, b.high, b.low, b.close, b.pre_close AS "preClose", b.vol,',
    '       b.turnover_rate AS "turnoverRate", b.circ_mv AS "circMv"',
    'FROM daily_bars b',
    'JOIN stocks s ON s.ts_code = b."tsCode"',
    'WHERE b."tradeDate" >= $1 AND b."tradeDate" <= $2',
    '  AND s.is_active = true',
    "  AND s.ts_code ~ '^(600|601|603|605|000|001|002|003)'",
    "  AND s.name !~ '(ST|退)'",
  ].join('\n');
  return prisma.$queryRawUnsafe<RawBar[]>(sql, start, end);
}

/** 落盘样本：一行一个信号，含全部低位类因子 + 收益 */
interface Row {
  code: string;
  date: string;
  year: string;
  rT1: number;   // T+1 当日最高（相对买点 %）
  rT5: number;   // T+5 累计最高（相对买点 %）
  /** 前向逐日路径 T+1..T+5，各项为「相对确认日收盘(买点)」的百分比。
   *  有了它，最高/最低/收盘/持有收益/回撤等任何口径都能离线算，无需重跑回测。 */
  fwd: { o: number; c: number; h: number; l: number }[];
  // 位置类（低位代理）
  gain60: number | null;
  pctFrom60Low: number | null;
  ddFrom60High: number | null;
  ma60SlopePct: number | null;
  ma60Below: number;      // 1 = 收盘在 MA60 下方
  maDualBull: number;     // 1 = MA5>MA10>MA20 且 收盘>MA5
  macdQuad: string;       // g0/d0/g1/d1（金叉/死叉 × DIF>0/<0）
  difVal: number | null;
  // 形态/量能（用于控制变量与稳健性）
  changePct: number | null;
  amplitudePct: number | null;
  volRatio: number | null;
  confVolRatio: number | null;
  t0Turnover: number | null;
  confTurnover: number | null;
  upperShadowPct: number | null;
  shadowRatio: number | null;
  bodyAbsPct: number | null;
  confPct: number | null;
  confDayGain: number | null;
  confClosePos: number | null;
  confOpenGap: number | null;
  t0NearHigh20: number | null;  // 试盘日收盘 / 前20日最高 - 1（%，负数=在下方）
  // 板块共振（口径复用 backtest-xianren-scorefactor-gradient.ts，打分主因子）
  hitCount: number;
  maxShadow: number;
  sectorVolRatioT: number | null;
  circMvYi: number | null;
}

// ===== 板块共振：口径与 backtest-xianren-scorefactor-gradient.ts 完全一致 =====
// 概念指数 T-1 长上影(>=1.5%) 且 T 反包上影>=50% → 该概念在 T 日命中。
const SECTOR_LOAD_START = '20210601';
const SECTOR_LOAD_END = '20270110';

async function loadConceptMembers(): Promise<Map<string, string[]>> {
  const rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT m.thscode, m.ts_code FROM ths_index_member m
     JOIN ths_index i ON i.thscode = m.thscode WHERE i.tag = 'cn_concept'`
  );
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const ths = String(r.thscode), ts = String(r.ts_code);
    if (!ths || !ts) continue;
    if (!out.has(ts)) out.set(ts, []);
    out.get(ts)!.push(ths);
  }
  return out;
}

async function loadConceptHits(): Promise<Map<string, Map<string, { shadow: number; volRatioT: number | null }>>> {
  const rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT d.ts_code, d.trade_date, d.open, d.high, d.close, d.vol
     FROM ths_index_daily d
     JOIN ths_index i ON i.thscode = d.ts_code AND i.tag = 'cn_concept'
     WHERE d.trade_date >= $1 AND d.trade_date <= $2
     ORDER BY d.ts_code, d.trade_date`,
    SECTOR_LOAD_START,
    SECTOR_LOAD_END
  );
  const byCode = new Map<string, { date: string; open: number; high: number; close: number; vol: number }[]>();
  for (const r of rows) {
    if (r.open == null || r.high == null || r.close == null) continue;
    const code = String(r.ts_code);
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code)!.push({
      date: fmtDate(String(r.trade_date)),
      open: Number(r.open), high: Number(r.high), close: Number(r.close), vol: Number(r.vol ?? 0),
    });
  }
  const out = new Map<string, Map<string, { shadow: number; volRatioT: number | null }>>();
  for (const [code, bars] of byCode) {
    const hits = new Map<string, { shadow: number; volRatioT: number | null }>();
    for (let i = 1; i < bars.length; i++) {
      const t0 = bars[i - 1], t = bars[i];
      const shadowTop = Math.max(t0.open, t0.close);
      if (!(t0.high > shadowTop) || t0.close <= 0) continue;
      const shadowPct = ((t0.high - shadowTop) / t0.close) * 100;
      if (shadowPct < 1.5) continue;
      if (t.close < t0.close + (t0.high - t0.close) * 0.5) continue;
      let volRatioT: number | null = null;
      const prev5 = bars.slice(Math.max(0, i - 5), i).map((b) => b.vol).filter((v) => v > 0);
      if (prev5.length >= 3) {
        const avg = prev5.reduce((a, b) => a + b, 0) / prev5.length;
        if (avg > 0) volRatioT = round(t.vol / avg);
      }
      hits.set(t.date, { shadow: shadowPct, volRatioT });
    }
    out.set(code, hits);
  }
  return out;
}

function processRaw(
  raw: RawBar[],
  year: string,
  rows: Row[],
  conceptsOf: Map<string, string[]>,
  conceptHits: Map<string, Map<string, { shadow: number; volRatioT: number | null }>>
): void {
  const byCode = new Map<string, RawBar[]>();
  for (const r of raw) {
    if (r.open == null || r.close == null || r.high == null || r.low == null) continue;
    if (!byCode.has(r.tsCode)) byCode.set(r.tsCode, []);
    byCode.get(r.tsCode)!.push(r);
  }

  for (const [code, rawBars] of byCode) {
    rawBars.sort((a, b) => (a.tradeDate < b.tradeDate ? -1 : 1));
    const bars: Bar[] = rawBars.map((r) => ({
      date: fmtDate(r.tradeDate),
      open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close),
      volume: Number(r.vol ?? 0),
      preClose: r.preClose != null ? Number(r.preClose) : null,
      turnoverRate: r.turnoverRate != null ? Number(r.turnoverRate) : null,
    }));
    if (bars.length < 130) continue;

    const closes = bars.map((x) => x.close);
    const ma = (i: number, n: number): number | null => {
      if (i < n - 1) return null;
      let s = 0;
      for (let j = i - n + 1; j <= i; j++) s += closes[j];
      return s / n;
    };

    for (let i = 65; i < bars.length; i++) {
      if (bars[i].date.slice(0, 4) !== year) continue;
      const t0 = bars[i - 1], t1 = bars[i];
      const upperShadow = t0.high - Math.max(t0.open, t0.close);
      if (!(upperShadow / t0.open * 100 >= 1.5)) continue;
      if (!(upperShadow > 0 && ((t1.close - t0.close) / upperShadow) * 100 >= 40)) continue;
      if (!(t1.high > t1.low ? (t1.close - t1.low) / (t1.high - t1.low) >= 0.7 : true)) continue;
      if (!(((t1.open - t0.close) / t0.close) * 100 <= 1.0)) continue;

      const sig = detectXianRenAt(bars as XianRenBar[], i, DEFAULT_XIANREN_CONFIG);
      if (!sig.matched) continue;
      if (sig.entryDate >= EX_LO && sig.entryDate <= EX_HI) continue;
      const entry = sig.entryPrice;
      if (!(entry > 0)) continue;

      const b1 = bars[i + 1];
      if (!b1) continue;
      let cum = -Infinity, ok = true;
      const fwd: { o: number; c: number; h: number; l: number }[] = [];
      for (let n = 1; n <= 5; n++) {
        const bb = bars[i + n];
        if (!bb) { ok = false; break; }
        if (bb.high > cum) cum = bb.high;
        fwd.push({
          o: round(((bb.open - entry) / entry) * 100),
          c: round(((bb.close - entry) / entry) * 100),
          h: round(((bb.high - entry) / entry) * 100),
          l: round(((bb.low - entry) / entry) * 100),
        });
      }
      if (!ok) continue;

      const t0Idx = i - 1;
      const m5 = ma(t0Idx, 5), m10 = ma(t0Idx, 10), m20 = ma(t0Idx, 20), m60 = ma(t0Idx, 60);
      const m60prev = ma(t0Idx - 5, 60);
      const ma60SlopePct = m60 != null && m60prev != null && m60prev > 0 ? ((m60 - m60prev) / m60prev) * 100 : null;

      let low60 = Infinity, high60 = -Infinity;
      for (let j = Math.max(0, t0Idx - 59); j <= t0Idx; j++) {
        if (bars[j].low < low60) low60 = bars[j].low;
        if (bars[j].high > high60) high60 = bars[j].high;
      }
      let high20 = -Infinity;
      for (let j = Math.max(0, t0Idx - 19); j < t0Idx; j++) if (bars[j].high > high20) high20 = bars[j].high;

      // MACD 象限：调用 lib 单一事实源（与生产 engine.ts 同一函数）
      const macd = computeMacdQuadAt(bars as XianRenBar[], t0Idx);
      const macdQuad = macd.quad;
      const d = macd.dif;

      const bodyAbs = Math.abs(t0.close - t0.open);

      // 板块共振：命中概念数 / 最强概念上影 / 最强概念 T 日量比
      let hitCount = 0, maxShadow = 0, sectorVolRatioT: number | null = null;
      for (const c of conceptsOf.get(code) ?? []) {
        const h = conceptHits.get(c)?.get(sig.entryDate);
        if (!h) continue;
        hitCount += 1;
        if (h.shadow > maxShadow) { maxShadow = h.shadow; sectorVolRatioT = h.volRatioT; }
      }

      rows.push({
        code,
        date: sig.entryDate,
        year,
        rT1: round(((b1.high - entry) / entry) * 100),
        rT5: round(((cum - entry) / entry) * 100),
        fwd,
        gain60: sig.metrics.gain60,
        pctFrom60Low: Number.isFinite(low60) && low60 > 0 ? round(((t0.close - low60) / low60) * 100) : null,
        ddFrom60High: Number.isFinite(high60) && high60 > 0 ? round(((t0.close - high60) / high60) * 100) : null,
        ma60SlopePct: ma60SlopePct != null ? round(ma60SlopePct) : null,
        ma60Below: m60 != null && t0.close < m60 ? 1 : 0,
        maDualBull: m5 != null && m10 != null && m20 != null && m5 > m10 && m10 > m20 && t0.close > m5 ? 1 : 0,
        macdQuad,
        difVal: Number.isFinite(d) && macdQuad !== 'na' ? round(d) : null,
        changePct: sig.metrics.changePct,
        amplitudePct: sig.metrics.amplitudePct,
        volRatio: sig.metrics.volRatio,
        confVolRatio: sig.metrics.confVolRatio,
        t0Turnover: t0.turnoverRate,
        confTurnover: t1.turnoverRate,
        upperShadowPct: sig.metrics.upperShadowPct,
        shadowRatio: bodyAbs > 0.01 ? round(upperShadow / bodyAbs) : null,
        bodyAbsPct: sig.metrics.bodyAbsPct,
        confPct: sig.metrics.confPct,
        confDayGain: sig.metrics.confDayGain,
        confClosePos: sig.metrics.confClosePos,
        confOpenGap: sig.metrics.confOpenGap,
        t0NearHigh20: Number.isFinite(high20) && high20 > 0 ? round(((t0.close - high20) / high20) * 100) : null,
        hitCount,
        maxShadow: round(maxShadow),
        sectorVolRatioT,
        circMvYi: rawBars[i].circMv != null ? round(Number(rawBars[i].circMv) / 10000, 1) : null,
      });
    }
  }
}

function selfTest(): void {
  const mk = (arr: number[]): XianRenBar[] => arr.map((c, i) => ({
    date: `2025-01-${String((i % 28) + 1).padStart(2, '0')}`,
    open: c, high: c, low: c, close: c, volume: 1000,
  }));
  const up = mk(Array.from({ length: 80 }, (_, i) => 10 + i * 0.1));
  const down = mk(Array.from({ length: 80 }, (_, i) => 20 - i * 0.1));
  const mu = computeMacdQuadAt(up, 79);
  const md = computeMacdQuadAt(down, 79);
  console.log('uptrend  ', round(mu.dif, 4), round(mu.dea, 4), '=>', mu.quad, '(应 g0)');
  console.log('downtrend', round(md.dif, 4), round(md.dea, 4), '=>', md.quad, '(应 d1)');
  const short = mk(Array.from({ length: 20 }, (_, i) => 10 + i * 0.1));
  console.log('short(20)', computeMacdQuadAt(short, 19).quad, '(应 na)');
  console.log('rows schema ok');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) { selfTest(); return; }
  if (!('confVolRatioMax' in DEFAULT_XIANREN_CONFIG)) {
    throw new Error('lib/strategy/xian-ren-zhi-lu.ts 缺少 confVolRatioMax：请先同步工作区版本再跑。');
  }
  const outArg = args.find((a) => a.startsWith('--out='));
  const out = outArg ? outArg.slice('--out='.length) : '/tmp/xr-lowpos.json';
  const yearsArg = args.find((a) => a.startsWith('--years='));
  const years = yearsArg ? yearsArg.slice('--years='.length).split(',').map((s) => s.trim()).filter(Boolean) : YEARS;

  const latestRow = await prisma.dailyBar.findFirst({ orderBy: { tradeDate: 'desc' }, select: { tradeDate: true } });
  if (!latestRow) throw new Error('no daily bars');
  const latestDate = latestRow.tradeDate;

  console.log('loading concept members/hits ...');
  const ts0 = Date.now();
  const conceptsOf = await loadConceptMembers();
  const conceptHits = await loadConceptHits();
  console.log(`sector loaded: ${conceptsOf.size} stocks, ${conceptHits.size} concepts, ${Date.now() - ts0}ms`);
  if (conceptHits.size === 0) throw new Error('板块共振数据为空，无法验证 hitCount 相关结论');

  const rows: Row[] = [];
  const t0 = Date.now();
  for (const year of years) {
    const loadStart = `${Number(year) - 1}0701`;
    const rawEnd = `${Number(year) + 1}0110`;
    const loadEnd = rawEnd < latestDate ? rawEnd : latestDate;
    const raw = await loadBars(loadStart, loadEnd);
    processRaw(raw, year, rows, conceptsOf, conceptHits);
    console.log(`[chunk] ${year} window ${loadStart}~${loadEnd} rows=${raw.length} signals=${rows.length} elapsed=${Date.now() - t0}ms`);
  }

  writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), years, count: rows.length, rows }));
  console.log(`wrote ${out} (${rows.length} rows)`);
  console.log('total elapsed', Date.now() - t0, 'ms');
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
