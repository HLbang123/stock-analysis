/**
 * 论点起点检测器 —— 从市场里找出「值得展开调查的一个点」
 *
 * 三种起点（设计见 docs/thesis-driven-selection.md 第三节）：
 *   D1 景气聚类  forecast/express 在同概念内富集   → 「某产业链景气」
 *   D2 题材聚集  kpl_list.lu_desc 同日多只涨停     → 「资金正在向这个题材聚集」
 *   D3 资金流跃升 industry_moneyflow_ths 排名跃升  → 「钱在往这个行业走」（仅 469 天，辅助）
 *
 * 🔴 纪律（预注册式的自我约束）：
 *   - 起点由「客观事实」触发，**绝不由历史收益率触发**（否则退回数据窥探）
 *   - 阈值是检测门槛，不是收益优化参数；调阈值不算窥探（不涉及收益）
 */

import { prisma } from "../../lib/db";

export type SeedKind = "d1_boom" | "d2_theme" | "d3_flow" | "idea";

export interface Seed {
  kind: SeedKind;
  subject: string;
  subjectCode: string | null;
  metric: Record<string, unknown>;
}

/** 概念黑名单 + 派生关键词，一次载入 */
let blocklistCache: Set<string> | null = null;
export async function loadBlocklist(): Promise<Set<string>> {
  if (blocklistCache) return blocklistCache;
  const rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT concept_name FROM thesis_concept_blocklist`
  );
  blocklistCache = new Set(rows.map((r) => r.concept_name));
  return blocklistCache;
}

/** 派生标签：名字本身由信号算出，用它做检测是循环论证 */
export function isDerivedName(name: string): boolean {
  return /(预增|预盈|预减|年报|中报|季报|业绩)/.test(name);
}

// ============================================================
// 超几何检验：概念内命中 x 个，是否显著多于随机期望
//   N = 全市场股票数, M = 全市场命中数, k = 概念成分数, x = 概念内命中数
//   p = P(X >= x)
// ============================================================
const logFactCache: number[] = [0];
function logFact(n: number): number {
  if (n < 0) return 0;
  for (let i = logFactCache.length; i <= n; i++) {
    logFactCache[i] = logFactCache[i - 1] + Math.log(i);
  }
  return logFactCache[n];
}
function logChoose(n: number, k: number): number {
  if (k < 0 || k > n) return -Infinity;
  return logFact(n) - logFact(k) - logFact(n - k);
}
/** P(X >= x)，X ~ Hypergeometric(N, M, k) */
export function hypergeomTail(N: number, M: number, k: number, x: number): number {
  if (x <= 0) return 1;
  const hi = Math.min(k, M);
  if (x > hi) return 0;
  // log-sum-exp 保证数值稳定
  const terms: number[] = [];
  for (let i = x; i <= hi; i++) {
    terms.push(logChoose(M, i) + logChoose(N - M, k - i) - logChoose(N, k));
  }
  const mx = Math.max(...terms);
  if (!Number.isFinite(mx)) return 0;
  const s = terms.reduce((a, t) => a + Math.exp(t - mx), 0);
  return Math.min(1, Math.exp(mx) * s);
}

// ============================================================
// D1 景气聚类
// ============================================================
/** 某个板块在窗口内的景气富集度（供 expand 复用，任何起点都能拿到这组数） */
export async function computeEnrichment(
  boardCode: string,
  asOf: string,
  from: string,
  /** PIT 快照日。**必须由调用方传入**（它带 fallback）；
   *  此前本函数自己算 `max(as_of)<=asOf`，快照晚于扫描日时返回 NULL → 静默算出空富集。 */
  snap: string
): Promise<{ k: number; x: number; expected: number; enrich: number; p: number; N: number; M: number; hits: any[] } | null> {
  const u: any[] = await prisma.$queryRawUnsafe(
    `SELECT count(DISTINCT "tsCode")::int AS n FROM daily_bars WHERE "tradeDate" = $1`, asOf);
  const N: number = u[0]?.n ?? 0;
  if (!N) return null;
  const rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT ts_code, ann_date, type, summary FROM forecast
     WHERE ann_date BETWEEN $1 AND $2 AND type IN ('预增','扭亏','略增')`, from, asOf);
  const hit = new Set(rows.map((r) => r.ts_code));
  const M = hit.size;
  const mem: any[] = await prisma.$queryRawUnsafe(
    `SELECT ts_code FROM ths_index_member_snapshots WHERE thscode = $1 AND as_of = $2`,
    boardCode, snap);
  const k = mem.length;
  if (!k) return null;
  const x = mem.reduce((a, m) => a + (hit.has(m.ts_code) ? 1 : 0), 0);
  const expected = k * (M / N);
  return {
    k, x, N, M,
    expected: +expected.toFixed(2),
    enrich: expected > 0 ? +(x / expected).toFixed(2) : 0,
    p: +hypergeomTail(N, M, k, x).toFixed(4),
    hits: rows.filter((r) => mem.some((m) => m.ts_code === r.ts_code)),
  };
}

export interface D1Options {
  /** 回看自然日数 */
  windowDays?: number;
  /** 富集倍数下限 */
  minEnrich?: number;
  /** 超几何 p 值上限 */
  maxP?: number;
  /** 概念内命中家数下限 */
  minHits?: number;
}

export async function detectD1(asOf: string, opts: D1Options = {}): Promise<Seed[]> {
  const windowDays = opts.windowDays ?? 40;
  // 阈值是「发现」门槛，不是「交易」门槛：宁可多给几张卡让人筛，也不要漏掉。
  //
  // 🔴 为什么不用超几何 p 值做硬过滤（重要，勿改回去）：
  //   实测（20260910，40 日窗口）全市场只有 M≈29 家正面预告，基准率 ≈0.54%。
  //   一个小概念（k≈200）命中 2 家时期望仅 1.1，超几何 p≈0.38 —— **永远过不了 0.05**。
  //   即：本场景下该检验**没有统计功效**，用它当门槛 = D1 永不触发 = 检测器是死的。
  //   故改为「富集倍数 ≥ 2（至少是随机期望的两倍）」这一**可解释**判据；
  //   p 值仍计算并展示，供人判断，**只作信息不作门槛**。
  const minEnrich = opts.minEnrich ?? 2.0;
  const maxP = opts.maxP ?? 1;
  const minHits = opts.minHits ?? 2;

  const d0 = new Date(
    Number(asOf.slice(0, 4)),
    Number(asOf.slice(4, 6)) - 1,
    Number(asOf.slice(6, 8))
  );
  d0.setDate(d0.getDate() - windowDays);
  const from = `${d0.getFullYear()}${String(d0.getMonth() + 1).padStart(2, "0")}${String(d0.getDate()).padStart(2, "0")}`;

  // 全市场股票数 N（当日有行情的）
  const u: any[] = await prisma.$queryRawUnsafe(
    `SELECT count(DISTINCT "tsCode")::int AS n FROM daily_bars WHERE "tradeDate" = $1`,
    asOf
  );
  const N: number = u[0]?.n ?? 0;
  if (!N) return [];

  // 窗口内基本面事件（正面的）—— 这是「景气」的证据
  const rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT ts_code, ann_date, type, summary, p_change_min, p_change_max
     FROM forecast
     WHERE ann_date BETWEEN $1 AND $2 AND type IN ('预增','扭亏','略增')`,
    from,
    asOf
  );
  const hitCodes = new Set(rows.map((r) => r.ts_code));
  const M = hitCodes.size;
  if (M < 5) return [];
  const rate = M / N;

  // 概念成分（PIT 快照）
  const snap = await latestSnapshotAsOf(asOf);
  if (!snap.d) return [];
  if (snap.fallback) console.warn(`[thesis] ⚠️ 无 <= ${asOf} 的成分快照，退回最早快照 ${snap.d}（有轻微前视）`);
  const mem: any[] = await prisma.$queryRawUnsafe(
    `SELECT s.thscode, s.ts_code, i.name
     FROM ths_index_member_snapshots s
     JOIN ths_index i ON i.thscode = s.thscode
     WHERE s.as_of = $1 AND s.tag = 'cn_concept'`,
    snap.d
  );

  const block = await loadBlocklist();
  const byConcept = new Map<string, { code: string; members: string[] }>();
  for (const m of mem) {
    if (block.has(m.name) || isDerivedName(m.name)) continue;
    let e = byConcept.get(m.name);
    if (!e) { e = { code: m.thscode, members: [] }; byConcept.set(m.name, e); }
    e.members.push(m.ts_code);
  }

  const seeds: Seed[] = [];
  for (const [name, { code, members }] of byConcept) {
    const k = members.length;
    if (k < minHits) continue;
    const x = members.reduce((a, c) => a + (hitCodes.has(c) ? 1 : 0), 0);
    if (x < minHits) continue;
    const expected = k * rate;
    const enrich = x / expected;
    if (enrich < minEnrich) continue;
    const p = hypergeomTail(N, M, k, x);
    if (p > maxP) continue;

    // 命中的具体公司 + 预告内容（供展开阶段用）
    const hits = rows
      .filter((r) => members.includes(r.ts_code))
      .map((r) => ({
        ts_code: r.ts_code,
        ann_date: r.ann_date,
        type: r.type,
        summary: (r.summary ?? "").slice(0, 120),
        p_change_min: r.p_change_min,
        p_change_max: r.p_change_max,
      }));

    seeds.push({
      kind: "d1_boom",
      subject: name,
      subjectCode: code,
      metric: { k, x, expected: +expected.toFixed(2), enrich: +enrich.toFixed(2), p: +p.toFixed(4), N, M, from, to: asOf, hits },
    });
  }

  seeds.sort((a, b) => (b.metric.enrich as number) - (a.metric.enrich as number));
  return seeds;
}

// ============================================================
// D2 题材聚集（用涨停池当「传感器」，不是买入信号）
// ============================================================
export interface D2Options {
  minCount?: number;
}

/** 与题材无关的 lu_desc，直接排除 */
const THEME_NOISE = new Set(["无", "ST板块", "次新股", "新股", "其他"]);

export async function detectD2(asOf: string, opts: D2Options = {}): Promise<Seed[]> {
  const minCount = opts.minCount ?? 4;
  const rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT lu_desc, count(*)::int AS n,
            array_agg(ts_code ORDER BY ts_code) AS codes,
            array_agg(DISTINCT status) AS statuses
     FROM kpl_list
     WHERE trade_date = $1
       AND status <> '新上市未开板'
       AND lu_desc IS NOT NULL AND lu_desc <> ''
       AND (name IS NULL OR (name NOT LIKE '%ST%' AND name NOT LIKE '%退%'))
     GROUP BY lu_desc
     HAVING count(*) >= $2
     ORDER BY n DESC`,
    asOf,
    minCount
  );

  return rows
    .filter((r) => !THEME_NOISE.has(r.lu_desc))
    .map((r) => ({
      kind: "d2_theme" as const,
      subject: r.lu_desc,
      subjectCode: null,
      metric: { count: r.n, codes: r.codes, statuses: r.statuses },
    }));
}

// ============================================================
// D3 资金流跃升（数据仅 469 天，只作辅助）
// ============================================================
export interface D3Options {
  topN?: number;
}

export async function detectD3(asOf: string, opts: D3Options = {}): Promise<Seed[]> {
  const topN = opts.topN ?? 3;
  // 当日净流入排名 vs 前 5 日均值排名，找「跃升」
  const rows: any[] = await prisma.$queryRawUnsafe(
    `WITH cur AS (
       SELECT ts_code, industry, net_amount, pct_change, lead_stock, lead_stock_pct,
              rank() OVER (ORDER BY net_amount DESC) AS rk
       FROM industry_moneyflow_ths WHERE trade_date = $1
     ),
     hist AS (
       SELECT ts_code, avg(rk) AS avg_rk FROM (
         SELECT ts_code, trade_date,
                rank() OVER (PARTITION BY trade_date ORDER BY net_amount DESC) AS rk
         FROM industry_moneyflow_ths
         WHERE trade_date < $1 AND trade_date >= to_char(to_date($1,'YYYYMMDD') - 30, 'YYYYMMDD')
       ) t GROUP BY ts_code
     )
     SELECT c.industry, c.ts_code, c.net_amount, c.pct_change, c.lead_stock, c.lead_stock_pct,
            c.rk::int AS rk, h.avg_rk
     FROM cur c LEFT JOIN hist h ON h.ts_code = c.ts_code
     WHERE c.rk <= 15
     ORDER BY c.rk`,
    asOf
  );

  const seeds: Seed[] = [];
  for (const r of rows) {
    const jump = r.avg_rk != null ? Number(r.avg_rk) - Number(r.rk) : null;
    // 只收「明显跃升」的：进了前 5，或比自身 30 日均排名前进 ≥ 15 位
    if (Number(r.rk) > 5 && !(jump != null && jump >= 15)) continue;
    seeds.push({
      kind: "d3_flow",
      subject: r.industry,
      subjectCode: r.ts_code,
      metric: {
        net_amount: r.net_amount,
        pct_change: r.pct_change,
        lead_stock: r.lead_stock,
        lead_stock_pct: r.lead_stock_pct,
        rank: r.rk,
        avg_rank_30d: r.avg_avg_rk ?? (r.avg_rk != null ? +Number(r.avg_rk).toFixed(1) : null),
        jump: jump != null ? +jump.toFixed(1) : null,
      },
    });
    if (seeds.length >= topN) break;
  }
  return seeds;
}

// ============================================================
// 工具
// ============================================================

/**
 * 取 <= 目标日 的最新 PIT 成分快照。
 *
 * ⚠️ 兜底语义（重要）：若目标日**早于**我们拥有的最早快照（首份快照 20260914），
 * 则退回**最早的那一份**，并在返回值里标记 fallback=true。
 * 原因是：对早于首份快照的日期，我们没有「当时的成分」，最早的快照是最接近的代理。
 * 代价：这引入了轻微的前视（用 09-14 的成分去看 09-10）。
 *   - 对**当前/实时**扫描（本系统的真实用法）无影响；
 *   - 对**历史回测**有影响，调用方必须把 fallback 标出来。
 */
export async function latestSnapshotAsOf(
  asOf: string
): Promise<{ d: string | null; fallback: boolean }> {
  const r: any[] = await prisma.$queryRawUnsafe(
    `SELECT
       (SELECT max(as_of) FROM ths_index_member_snapshots WHERE as_of <= $1) AS exact_d,
       (SELECT min(as_of) FROM ths_index_member_snapshots)                  AS first_d`,
    asOf
  );
  const exact = r[0]?.exact_d ?? null;
  if (exact) return { d: exact, fallback: false };
  const first = r[0]?.first_d ?? null;
  return { d: first, fallback: !!first };
}
