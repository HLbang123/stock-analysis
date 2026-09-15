/**
 * 论点系统：共享流程（CLI 与 API 共用同一套代码）
 *
 *   resolveIdeaFromText  一句话 → 概念板块
 *   runInvestigation     起点 → 展开 → 反证 → 落库，返回卡片
 */

import { prisma } from "../../lib/db";
import type { Seed, SeedKind } from "./detect";
import { expand, narrate, templateNarrative, type Evidence, type Narrative } from "./investigate";

/** 取最新交易日 */
export async function latestTradeDate(): Promise<string> {
  const r: any[] = await prisma.$queryRawUnsafe(
    // 生产只有 daily_bars（bar_rn 是本地研究表）
    `SELECT max("tradeDate") AS d FROM daily_bars`
  );
  return r[0].d;
}

const STOPWORDS = new Set([
  "涨价", "跌价", "景气", "周期", "概念", "板块", "行情", "机会", "看好",
  "复苏", "爆发", "反转", "启动", "受益", "逻辑", "方向", "赛道",
]);

/**
 * 「由点及面」：把一句人话映射到板块
 * 四级：精确 → 分词 → 最长公共子串(≥2) → 涨停原因
 */
export async function resolveIdeaFromText(
  idea: string
): Promise<{ subject: string; code: string | null; how: string } | null> {
  // 1) 精确
  let r: any[] = await prisma.$queryRawUnsafe(
    `SELECT i.name, i.thscode FROM ths_index i WHERE i.tag='cn_concept' AND i.name=$1 LIMIT 1`,
    idea
  );
  if (r.length) return { subject: r[0].name, code: r[0].thscode, how: "概念名精确命中" };

  // 2) 分词
  const tokens = idea
    .split(/[\s,，、。;；:：/|()+\-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
  for (const t of [...tokens, idea]) {
    r = await prisma.$queryRawUnsafe(
      `SELECT i.name, i.thscode, length(i.name) AS L FROM ths_index i
       WHERE i.tag='cn_concept' AND (i.name LIKE '%'||$1||'%' OR $1 LIKE '%'||i.name||'%')
       ORDER BY L DESC LIMIT 1`,
      t
    );
    if (r.length) return { subject: r[0].name, code: r[0].thscode, how: `分词「${t}」命中概念名` };
  }

  // 3) 最长公共子串
  const all: any[] = await prisma.$queryRawUnsafe(
    `SELECT i.name, i.thscode FROM ths_index i WHERE i.tag='cn_concept'`
  );
  let best: { name: string; code: string; score: number } | null = null;
  for (const c of all) {
    const sc = lcs(idea, c.name);
    if (!best || sc > best.score) best = { name: c.name, code: c.thscode, score: sc };
  }
  if (best && best.score >= 2)
    return { subject: best.name, code: best.code, how: `最长公共子串 ${best.score} 字（模糊）` };

  // 4) 涨停原因
  r = await prisma.$queryRawUnsafe(
    `SELECT lu_desc AS name, NULL AS thscode FROM kpl_list
     WHERE lu_desc IS NOT NULL AND (lu_desc LIKE '%'||$1||'%' OR $1 LIKE '%'||lu_desc||'%')
     GROUP BY lu_desc ORDER BY count(*) DESC LIMIT 1`,
    idea
  );
  if (r.length) return { subject: r[0].name, code: null, how: "涨停原因匹配（无对应概念板块）" };
  return null;
}

function lcs(a: string, b: string): number {
  let best = 0;
  const dp = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : 0;
      if (dp[j] > best) best = dp[j];
      prev = tmp;
    }
  }
  return best;
}

/** 完整调查：展开 → 反证/叙述 → 落库 */
export async function runInvestigation(
  seed: Seed,
  asOf?: string
): Promise<{ cardId: number; seedId: number; subject: string }> {
  const date = asOf ?? (seed.metric.to as string) ?? (await latestTradeDate());
  const ev = await expand(seed, date);
  const na = await narrate(ev);

  const seedRow: any[] = await prisma.$queryRawUnsafe(
    `INSERT INTO thesis_seeds (seed_date, kind, subject, subject_code, metric, source)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6)
     ON CONFLICT (seed_date, kind, subject) DO UPDATE SET metric = EXCLUDED.metric
     RETURNING seed_id`,
    date, seed.kind, seed.subject, seed.subjectCode,
    JSON.stringify(seed.metric), seed.kind === "idea" ? "user" : "auto"
  );
  const seedId = seedRow[0].seed_id;

  const cand = (ev.concept?.listed ?? [])
    .slice()
    .sort((a, b) => (b.pct20 ?? -999) - (a.pct20 ?? -999))
    .slice(0, 20);

  const card: any[] = await prisma.$queryRawUnsafe(
    `INSERT INTO thesis_cards
       (seed_id, card_date, subject, evidence, candidates, thesis, mispricing, counter,
        triggers, llm_used, narrated_by, seed_kind)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9::jsonb,$10,$11,$12)
     RETURNING card_id`,
    seedId, date, seed.subject, JSON.stringify(ev), JSON.stringify(cand),
    na.thesis, na.mispricing, na.counter, JSON.stringify(na.triggers),
    na.llmUsed, na.llmUsed ? "api" : "template", seed.kind
  );
  return { cardId: card[0].card_id, seedId, subject: seed.subject };
}

export type { Seed, SeedKind };

// ============================================================
// 用户路径（零服务器 LLM 成本）
//
// 为什么拆成两步：用户输入想法如果走服务器 key，用户一多额度会被打爆。
// 所以服务器只做**确定性**的部分（纯 SQL：解析想法→板块、采集证据、生成模板叙述），
// 叙述交给**用户自己的 LLM** 在浏览器里直连完成（见 components/ThesisTab.tsx）。
// ============================================================

export interface ResolvedIdea {
  subject: string;
  code: string | null;
  how: string;
  asOf: string;
  evidence: Evidence;
  /** 无 LLM 时的兜底叙述（服务器生成，零成本） */
  template: Narrative;
}

/** 只做确定性部分：想法 → 板块 → 证据 → 模板叙述。**不调 LLM。** */
export async function resolveIdea(idea: string, asOf?: string): Promise<ResolvedIdea | null> {
  const hit = await resolveIdeaFromText(idea);
  if (!hit) return null;
  const date = asOf ?? (await latestTradeDate());
  const seed: Seed = { kind: "idea", subject: hit.subject, subjectCode: hit.code, metric: { idea, to: date } };
  const evidence = await expand(seed, date);
  return {
    subject: hit.subject,
    code: hit.code,
    how: hit.how,
    asOf: date,
    evidence,
    template: templateNarrative(evidence),
  };
}

/** 落库（叙述由调用方给：浏览器 LLM 或服务器模板）。**不调 LLM。** */
export async function saveCard(args: {
  subject: string;
  subjectCode: string | null;
  asOf: string;
  kind: SeedKind;
  metric: Record<string, unknown>;
  evidence: Evidence;
  narrative: Narrative;
  narratedBy: string;
}): Promise<number> {
  const seedRow: any[] = await prisma.$queryRawUnsafe(
    `INSERT INTO thesis_seeds (seed_date, kind, subject, subject_code, metric, source)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6)
     ON CONFLICT (seed_date, kind, subject) DO UPDATE SET metric = EXCLUDED.metric
     RETURNING seed_id`,
    args.asOf, args.kind, args.subject, args.subjectCode,
    JSON.stringify(args.metric), args.kind === "idea" ? "user" : "auto"
  );
  const seedId = seedRow[0].seed_id;
  const cand = (args.evidence.concept?.listed ?? [])
    .slice().sort((a, b) => (b.pct20 ?? -999) - (a.pct20 ?? -999)).slice(0, 20);
  const na = args.narrative;
  const card: any[] = await prisma.$queryRawUnsafe(
    `INSERT INTO thesis_cards
       (seed_id, card_date, subject, evidence, candidates, thesis, mispricing, counter,
        triggers, llm_used, narrated_by, seed_kind)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9::jsonb,$10,$11,$12)
     RETURNING card_id`,
    seedId, args.asOf, args.subject, JSON.stringify(args.evidence), JSON.stringify(cand),
    na.thesis, na.mispricing, na.counter, JSON.stringify(na.triggers ?? []),
    na.llmUsed, args.narratedBy, args.kind
  );
  return card[0].card_id;
}

// ============================================================
// 线索墙（用户洞察的共享资产）
//
// 用户 2026-09-14 定调：**定时任务只能从「已有数据」里找论点，而人能提供
// 「数据还没体现」的信息**（听说涨价、拿到订单、政策要变）—— 这是 LLM 凭空产生不了的。
// 故：① 用户提交的想法**全部强制公开**；② 服务器 key 只给「≥3 人独立提出」的线索兜底跑研判。
// ============================================================

/** 记录一次用户提交（同一匿名 id 对同一板块只计一次，防刷） */
export async function recordProposal(args: {
  idea: string;
  subject: string;
  subjectCode: string | null;
  asOf: string;
  anonId: string | null;
}): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO thesis_proposals (idea, subject, subject_code, as_of, anon_id)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (subject, anon_id) WHERE anon_id IS NOT NULL DO NOTHING`,
    args.idea.slice(0, 300), args.subject, args.subjectCode, args.asOf, args.anonId
  );
}

export interface WallItem {
  subject: string;
  subjectCode: string | null;
  /** 几个不同的人独立提出过 —— 这是排序与「是否值得服务器兜底」的依据 */
  proposers: number;
  proposals: number;
  lastAt: string;
  ideas: string[];
  card: any | null;
}

/** 线索墙：按「提出人数」排序（多人独立想到同一件事，本身就有信息量） */
export async function thesisWall(limit = 50): Promise<WallItem[]> {
  const rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT subject, subject_code,
            count(DISTINCT anon_id)::int AS proposers,
            count(*)::int               AS proposals,
            max(created_at)             AS last_at,
            (array_agg(DISTINCT idea))[1:3] AS ideas
     FROM thesis_proposals
     GROUP BY subject, subject_code
     ORDER BY proposers DESC, last_at DESC
     LIMIT $1`,
    limit
  );
  const out: WallItem[] = [];
  for (const r of rows) {
    // 该板块最近一张卡（研判与证据）
    const c: any[] = await prisma.$queryRawUnsafe(
      `SELECT c.card_id, c.card_date, c.thesis, c.mispricing, c.counter, c.triggers,
              c.narrated_by, c.llm_used, c.candidates, c.evidence, c.verdict, c.verdict_note
       FROM thesis_cards c
       WHERE c.subject = $1
       ORDER BY (c.narrated_by IN ('api','server')) DESC, c.card_id DESC
       LIMIT 1`,
      r.subject
    );
    out.push({
      subject: r.subject,
      subjectCode: r.subject_code,
      proposers: r.proposers,
      proposals: r.proposals,
      lastAt: r.last_at,
      ideas: r.ideas ?? [],
      card: c.length
        ? {
            cardId: c[0].card_id, cardDate: c[0].card_date,
            thesis: c[0].thesis, mispricing: c[0].mispricing, counter: c[0].counter,
            triggers: c[0].triggers ?? [], narratedBy: c[0].narrated_by,
            candidates: c[0].candidates ?? [], evidence: c[0].evidence,
            verdict: c[0].verdict, verdictNote: c[0].verdict_note,
          }
        : null,
    });
  }
  return out;
}

/** 够热但还没有服务器研判的线索（供 scripts/thesis-hot.ts 兜底跑一次） */
export async function hotProposals(minProposers = 3): Promise<
  { subject: string; subjectCode: string | null; proposers: number; ideas: string[]; asOf: string }[]
> {
  const rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT p.subject, p.subject_code,
            count(DISTINCT p.anon_id)::int AS proposers,
            (array_agg(DISTINCT p.idea))[1:3] AS ideas,
            max(p.as_of) AS as_of
     FROM thesis_proposals p
     WHERE NOT EXISTS (
       SELECT 1 FROM thesis_cards c
       WHERE c.subject = p.subject AND c.narrated_by IN ('api','server')
     )
     GROUP BY p.subject, p.subject_code
     HAVING count(DISTINCT p.anon_id) >= $1
     ORDER BY proposers DESC`,
    minProposers
  );
  return rows.map((r) => ({
    subject: r.subject, subjectCode: r.subject_code,
    proposers: r.proposers, ideas: r.ideas ?? [], asOf: r.as_of,
  }));
}
