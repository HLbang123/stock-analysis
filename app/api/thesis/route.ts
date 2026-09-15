import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { resolveIdea, saveCard, recordProposal, thesisWall } from '@/services/thesis/pipeline';

/**
 * GET  /api/thesis?days=90          → 论点卡列表 + 复盘
 * POST /api/thesis  {action:'verdict', cardId, verdict, note}
 * POST /api/thesis  {action:'resolve', idea}    → 想法 → 板块 + 证据 + 模板叙述（**零 LLM**）
 * POST /api/thesis  {action:'save', ...}        → 落库（叙述由浏览器用**用户自己的 key** 生成）
 *
 * 🔴 成本约定（2026-09-14）：**本路由的任何用户路径都不许调服务器 LLM。**
 *    服务器每日扫描（scripts/thesis-scan.ts）才用服务器 key，一天一次、全用户共享结果。
 *    用户输入想法走 resolve(服务端纯 SQL) → 浏览器直连用户自己的模型 → save(服务端只存)。
 *
 * 设计见 docs/thesis-driven-selection.md。
 * 表不存在时返回空结构，前端显示空态，不报错。
 */

const HORIZONS = [5, 20];

async function tableReady(): Promise<boolean> {
  const r: any[] = await prisma.$queryRawUnsafe(
    `SELECT to_regclass('public.thesis_cards')::text AS t`
  );
  return !!r[0]?.t;
}

/**
 * 候选等权前瞻（card_date 次一交易日开盘买入 → 第 N 交易日收盘），并与同日全市场等权比较。
 *
 * 🔴 只用生产存在的表（daily_bars）。
 *    此前这里查的是 `bar_rn`（本地研究表）和 `mkt_ret`（本地预计算的市场收益表）——
 *    两张表生产都没有，于是论点页的复盘区块直接报
 *    `relation "bar_rn" does not exist`。**本地有、生产没有的表，绝不能出现在生产代码里。**
 *    （同一类问题本次已修第三处：services/thesis/*、thesis-setup、以及这里。）
 */
async function forwardFor(cardDate: string, codes: string[]) {
  if (!codes.length) return null;

  // 次一交易日（用 daily_bars，主键 (tsCode, tradeDate) 上取 min 很快）
  const cal: any[] = await prisma.$queryRawUnsafe(
    `SELECT min("tradeDate") AS buy_date FROM daily_bars WHERE "tradeDate" > $1`, cardDate);
  const buyDate = cal[0]?.buy_date;
  if (!buyDate) return null;

  // 买入后的第 5 / 第 20 个交易日（从该日起数的交易日历，全市场共用）
  const cal2: any[] = await prisma.$queryRawUnsafe(
    `SELECT "tradeDate" AS d FROM (
       SELECT DISTINCT "tradeDate" FROM daily_bars WHERE "tradeDate" > $1 ORDER BY "tradeDate" LIMIT 20
     ) t ORDER BY "tradeDate"`, buyDate);
  const dates: string[] = cal2.map((r) => r.d);
  const d5 = dates[4] ?? null, d20 = dates[19] ?? null;

  // 候选的买入开盘价 + T+5 / T+20 收盘（索引友好的 OFFSET 子查询）
  const rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT b."tsCode" AS ts_code, b.open,
            (SELECT x.close FROM daily_bars x WHERE x."tsCode"=b."tsCode" AND x."tradeDate">$1
               ORDER BY x."tradeDate" ASC OFFSET 4  LIMIT 1) AS c5,
            (SELECT x.close FROM daily_bars x WHERE x."tsCode"=b."tsCode" AND x."tradeDate">$1
               ORDER BY x."tradeDate" ASC OFFSET 19 LIMIT 1) AS c20
     FROM daily_bars b WHERE b."tradeDate"=$1 AND b."tsCode" = ANY($2::text[]) AND b.open>0`,
    buyDate, codes);

  // 市场基准：全市场等权（就地算，替代本地预计算表 mkt_ret）
  const benchOf = async (to: string | null): Promise<number | null> => {
    if (!to) return null;
    const b: any[] = await prisma.$queryRawUnsafe(
      `SELECT avg(x.close / NULLIF(p.close, 0) - 1) * 100 AS r
       FROM daily_bars p JOIN daily_bars x ON x."tsCode" = p."tsCode"
       WHERE p."tradeDate" = $1 AND x."tradeDate" = $2 AND p.close > 0`,
      buyDate, to);
    return b[0]?.r == null ? null : Number(b[0].r);
  };
  const bm5 = await benchOf(d5).catch(() => null);
  const bm20 = await benchOf(d20).catch(() => null);

  const out: Record<string, { ret: number; ex: number | null } | null> = {};
  for (const n of HORIZONS) {
    const closeOf = (r: any) => (n === 5 ? r.c5 : r.c20);
    const rets = rows.filter((r) => closeOf(r) != null)
      .map((r) => (Number(closeOf(r)) / Number(r.open) - 1) * 100);
    if (!rets.length) { out[`t${n}`] = null; continue; }
    const avg = rets.reduce((a, b) => a + b, 0) / rets.length;
    const idx = n === 5 ? bm5 : bm20;
    out[`t${n}`] = { ret: +avg.toFixed(2), ex: idx == null ? null : +(avg - idx).toFixed(2) };
  }
  return { buyDate, n: rows.length, ...out };
}

export async function GET(request: NextRequest) {
  const days = Math.min(Math.max(Number(new URL(request.url).searchParams.get('days') ?? 90), 5), 365);
  try {
    if (!(await tableReady())) {
      return NextResponse.json({ ready: false, cards: [], review: [], stats: null });
    }
    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT c.card_id, c.card_date, c.subject, c.seed_kind, c.thesis, c.mispricing, c.counter,
              c.triggers, c.candidates, c.evidence, c.llm_used, c.narrated_by,
              c.verdict, c.verdict_note, c.verdict_at,
              s.metric AS seed_metric, s.source AS seed_source
       FROM thesis_cards c LEFT JOIN thesis_seeds s ON s.seed_id = c.seed_id
       WHERE c.card_date >= to_char(to_date($1,'YYYYMMDD') - make_interval(days => $2::int), 'YYYYMMDD')
       ORDER BY c.card_date DESC, c.card_id DESC`,
      new Date().toISOString().slice(0, 10).replace(/-/g, ''), days);

    const cards: any[] = [];
    const review: any[] = [];
    for (const r of rows) {
      const cand = Array.isArray(r.candidates) ? r.candidates : [];
      const codes = cand.map((c: any) => c.ts_code).filter(Boolean);
      const fwd = await forwardFor(r.card_date, codes).catch(() => null);
      const item = {
        cardId: r.card_id, cardDate: r.card_date, subject: r.subject, kind: r.seed_kind,
        thesis: r.thesis, mispricing: r.mispricing, counter: r.counter,
        triggers: r.triggers ?? [], llmUsed: r.llm_used, narratedBy: r.narrated_by,
        verdict: r.verdict, verdictNote: r.verdict_note,
        seedSource: r.seed_source, seedMetric: r.seed_metric,
        enrichment: r.evidence?.enrichment ?? null,
        board: r.evidence?.board ?? null,
        flow: r.evidence?.flow ?? null,
        contrad: r.evidence?.contradicting ?? null,
        candidates: cand.slice(0, 20),
        forward: fwd,
      };
      cards.push(item);
      // 复盘：只收已到期（有 T+20 且卡龄 ≥ 20 交易日近似用日历 30 天）
      if (r.verdict && fwd && (fwd as any).t20) review.push(item);
    }

    const judged = cards.filter((c) => c.verdict);
    const stats = {
      totalCards: cards.length,
      judged: judged.length,
      byVerdict: ['buy', 'watch', 'skip'].map((v) => ({ verdict: v, n: judged.filter((c) => c.verdict === v).length })),
      reviewN: review.length,
      reviewEx20: review.length
        ? +(review.reduce((a, c) => a + ((c.forward as any)?.t20?.ex ?? 0), 0) / review.length).toFixed(2)
        : null,
    };
    // 线索墙：用户提交的想法（强制公开）+ 该方向最新的研判
    const wall = await thesisWall(50).catch((e) => {
      console.warn('[thesis] 线索墙查询失败：', String(e.message).slice(0, 120));
      return [];
    });
    return NextResponse.json({ ready: true, cards, review, stats, wall });
  } catch (e: any) {
    return NextResponse.json({ error: String(e.message ?? e).slice(0, 200) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (!(await tableReady())) {
      return NextResponse.json({ error: '论点表尚未建立，请先跑 scripts/thesis-setup.sql' }, { status: 400 });
    }

    if (body.action === 'verdict') {
      const cardId = Number(body.cardId);
      const verdict = String(body.verdict ?? 'watch');
      const note = String(body.note ?? '').slice(0, 500);
      if (!cardId || !['buy', 'watch', 'skip'].includes(verdict)) {
        return NextResponse.json({ error: '参数不合法' }, { status: 400 });
      }
      await prisma.$executeRawUnsafe(
        `UPDATE thesis_cards SET verdict=$1, verdict_note=$2, verdict_at=now() WHERE card_id=$3`,
        verdict, note, cardId);
      return NextResponse.json({ ok: true });
    }

    if (body.action === 'resolve') {
      const idea = String(body.idea ?? '').trim();
      if (idea.length < 2) return NextResponse.json({ error: '想法太短' }, { status: 400 });
      if (idea.length > 200) return NextResponse.json({ error: '想法太长（≤200 字）' }, { status: 400 });
      const r = await resolveIdea(idea);
      if (!r) return NextResponse.json({ error: `无法把「${idea}」映射到任何板块或题材` }, { status: 404 });

      // 提交即公开（用户 2026-09-14 定）。anonId 只用于「几人独立提出」计数，不是身份。
      const anonId = typeof body.anonId === 'string' ? body.anonId.slice(0, 64) : null;
      await recordProposal({
        idea, subject: r.subject, subjectCode: r.code, asOf: r.asOf, anonId,
      }).catch((e) => console.warn('[thesis] 提交记录失败：', String(e.message).slice(0, 120)));

      const cnt: any[] = await prisma.$queryRawUnsafe(
        `SELECT count(DISTINCT anon_id)::int AS n FROM thesis_proposals WHERE subject = $1`,
        r.subject
      );

      // 服务器到此为止：只给证据与模板。叙述由浏览器用用户自己的模型补。
      return NextResponse.json({
        ok: true, subject: r.subject, subjectCode: r.code, how: r.how, asOf: r.asOf,
        evidence: r.evidence, template: r.template,
        proposers: cnt[0]?.n ?? 1,
      });
    }

    if (body.action === 'save') {
      const { subject, subjectCode, asOf, kind, metric, evidence, narrative, narratedBy } = body;
      if (!subject || !asOf || !evidence || !narrative?.thesis) {
        return NextResponse.json({ error: 'save 参数不完整' }, { status: 400 });
      }
      const cardId = await saveCard({
        subject: String(subject),
        subjectCode: subjectCode ?? null,
        asOf: String(asOf),
        kind: (kind ?? 'idea') as any,
        metric: metric ?? {},
        evidence,
        narrative: {
          thesis: String(narrative.thesis ?? ''),
          mispricing: String(narrative.mispricing ?? ''),
          counter: String(narrative.counter ?? ''),
          triggers: Array.isArray(narrative.triggers) ? narrative.triggers.map(String).slice(0, 4) : [],
          llmUsed: !!narrative.llmUsed,
        },
        // 记录是哪条路产生的，便于事后核对成本来源
        narratedBy: String(narratedBy ?? 'user-llm'),
      });
      return NextResponse.json({ ok: true, cardId });
    }

    return NextResponse.json({ error: '未知 action' }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: String(e.message ?? e).slice(0, 200) }, { status: 500 });
  }
}
