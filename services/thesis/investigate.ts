/**
 * 论点调查：展开（确定性）+ 反证 + 叙述（LLM，可降级）
 *
 * 设计原则（docs/thesis-driven-selection.md）：
 *   1. 证据采集全部是确定性 SQL —— 无 LLM 也能出一张卡
 *   2. LLM 只做「读证据 → 写论点 / 写错价假设 / 写反面证据」，**不参与排序**
 *      （文献结论：无文本输入的 LLM 排序无增量价值，见 docs/selection-literature-review.md 2.4）
 *   3. 🔴 **反证是流程里的一步，不是卡片上的可选字段**。写不出反面证据的卡视为无效。
 *   4. 🔴 **谁付 LLM 的钱**（2026-09-14 定）：
 *        - 服务器每日扫描（scripts/thesis-scan.ts）→ 用**服务器 key**（一天一次，全用户共享结果）
 *        - 用户输入想法（网页）→ 用**用户自己的 key**，浏览器直连；服务器只做确定性证据采集
 *      绝不能让 /api/thesis 的 user 路径走服务器 key —— 那样用户一多额度会被打爆。
 */

import { prisma } from "../../lib/db";
import { buildChatUrl, buildLLMHeaders } from "../../lib/llm/shared";
import type { Seed } from "./detect";
import { latestSnapshotAsOf, isDerivedName, loadBlocklist, computeEnrichment } from "./detect";
import { NARRATE_PROMPT, compactEvidence, parseJsonLoose, type EvidenceLike } from "./narrate-prompt";

// ============================================================
// 类型
// ============================================================
export interface Member {
  ts_code: string;
  name: string;
  pct1: number | null;
  pct5: number | null;
  pct20: number | null;
  turnover: number | null;
  amount: number | null;
  close: number | null;
}

export interface Evidence {
  subject: string;
  asOf: string;
  kind: string;
  concept: { code: string | null; members: number; listed: Member[] } | null;
  fundamentals: {
    hits: { ts_code: string; ann_date: string; type: string; summary: string }[];
    recent: { ts_code: string; ann_date: string; type: string; summary: string }[];
  } | null;
  board: {
    code: string;
    ret5: number | null;
    ret20: number | null;
    ret60: number | null;
    pctile250: number | null;
  } | null;
  /** 景气富集度：任何起点都会算，用于判断「这个想法有没有基本面支撑」 */
  enrichment: { k: number; x: number; expected: number; enrich: number; p: number } | null;
  flow: {
    industry: string;
    net_amount: number | null;
    pct_change: number | null;
    lead_stock: string | null;
    lead_stock_pct: number | null;
  } | null;
  /** 反向数据：用来写反面证据的原始事实 */
  contradicting: {
    lossMaking: number;
    alreadyUp20: number;
    memberTotal: number;
    notes: string[];
  };
}

export interface Narrative {
  thesis: string;
  mispricing: string;
  counter: string;
  triggers: string[];
  llmUsed: boolean;
}

// ============================================================
// 展开：确定性证据采集
// ============================================================

/** 把「一个名字」解析成板块：概念优先 → 其次行业 → 再退回模糊匹配 */
export async function resolveBoard(
  subject: string,
  snap: string
): Promise<{ code: string; name: string; tag: string } | null> {
  let r: any[] = await prisma.$queryRawUnsafe(
    `SELECT i.thscode AS code, i.name, i.tag FROM ths_index i
     WHERE i.name = $1
     ORDER BY CASE i.tag WHEN 'cn_concept' THEN 0 ELSE 1 END LIMIT 1`,
    subject
  );
  if (r.length) return r[0];
  // 模糊：最长匹配，避免「芯片」压过「存储芯片」
  r = await prisma.$queryRawUnsafe(
    `SELECT i.thscode AS code, i.name, i.tag FROM ths_index i
     WHERE i.name LIKE '%' || $1 || '%' OR $1 LIKE '%' || i.name || '%'
     ORDER BY length(i.name) DESC LIMIT 1`,
    subject
  );
  return r.length ? r[0] : null;
}

/** 取板块成分（PIT）及其当日行情 + 近 5/20 日涨幅 */
async function loadMembers(boardCode: string, asOf: string, snap: string): Promise<Member[]> {
  const rows: any[] = await prisma.$queryRawUnsafe(
     // ⚠️ 只用 daily_bars（生产存在），**不依赖本地研究表 bar_rn**。
     //    ⚠️ 且三个都是「过去」的价：pct = close_now/x - 1，
     //       故 x 必须是 asOf 之前第 1/5/20 个交易日；此前误用 rn+5（未来价）→ 符号反 + 偷看未来。
     //    用索引友好的 OFFSET 子查询（daily_bars 主键就是 ("tsCode","tradeDate")），
     //    不用窗口函数 —— 生产 1096 万行 / 2 核，全表窗口会压垮。
    `SELECT s.ts_code, s.member_name AS name, d.close, d.turnover_rate AS turnover, d.amount,
            (SELECT x.close FROM daily_bars x WHERE x."tsCode"=d."tsCode" AND x."tradeDate"<$2
               ORDER BY x."tradeDate" DESC LIMIT 1)  AS cprev,
            (SELECT x.close FROM daily_bars x WHERE x."tsCode"=d."tsCode" AND x."tradeDate"<$2
               ORDER BY x."tradeDate" DESC OFFSET 4  LIMIT 1) AS c5,
            (SELECT x.close FROM daily_bars x WHERE x."tsCode"=d."tsCode" AND x."tradeDate"<$2
               ORDER BY x."tradeDate" DESC OFFSET 19 LIMIT 1) AS c20
     FROM ths_index_member_snapshots s
     LEFT JOIN daily_bars d ON d."tsCode" = s.ts_code AND d."tradeDate" = $2
     WHERE s.thscode = $1 AND s.as_of = $3`,
    boardCode,
    asOf,
    snap
  );
  return rows.map((r) => {
    const close = r.close != null ? Number(r.close) : null;
    const pct = (x: any) =>
      close && x != null ? +(((close / Number(x)) - 1) * 100).toFixed(2) : null;
    return {
      ts_code: r.ts_code,
      name: r.name ?? "",
      pct1: pct(r.cprev),
      pct5: pct(r.c5),
      pct20: pct(r.c20),
      turnover: r.turnover != null ? Number(r.turnover) : null,
      amount: r.amount != null ? Number(r.amount) : null,
      close,
    };
  });
}

/** 板块自身走势：这个论点是不是已经被 price in 了 */
async function boardPerf(boardCode: string, asOf: string): Promise<Evidence["board"]> {
  const b: any[] = await prisma.$queryRawUnsafe(
    `WITH cur AS (SELECT close FROM ths_index_daily WHERE ts_code=$1 AND trade_date=$2),
     p5  AS (SELECT close FROM ths_index_daily WHERE ts_code=$1 AND trade_date<=$2 ORDER BY trade_date DESC OFFSET 5 LIMIT 1),
     p20 AS (SELECT close FROM ths_index_daily WHERE ts_code=$1 AND trade_date<=$2 ORDER BY trade_date DESC OFFSET 20 LIMIT 1),
     p60 AS (SELECT close FROM ths_index_daily WHERE ts_code=$1 AND trade_date<=$2 ORDER BY trade_date DESC OFFSET 60 LIMIT 1),
     hist AS (
       SELECT close / NULLIF(lag(close,20) OVER (ORDER BY trade_date),0) - 1 AS r20
       FROM ths_index_daily WHERE ts_code=$1 AND trade_date<=$2 ORDER BY trade_date DESC LIMIT 250
     )
     SELECT (SELECT close FROM cur) AS c, (SELECT close FROM p5) AS c5,
            (SELECT close FROM p20) AS c20, (SELECT close FROM p60) AS c60,
            (SELECT count(*)::int FROM hist WHERE r20 IS NOT NULL) AS n,
            (SELECT count(*)::int FROM hist h WHERE h.r20 IS NOT NULL
               AND h.r20 <= (SELECT max(r20) FROM hist WHERE r20 IS NOT NULL)) AS below`,
    boardCode,
    asOf
  );
  const r = b[0];
  if (!r?.c) return null;
  const c = Number(r.c);
  const g = (x: any) => (x ? +(((c / Number(x)) - 1) * 100).toFixed(2) : null);
  return {
    code: boardCode,
    ret5: g(r.c5),
    ret20: g(r.c20),
    ret60: g(r.c60),
    pctile250: null,
  };
}

export async function expand(seed: Seed, asOf: string): Promise<Evidence> {
  const { d: snap, fallback } = await latestSnapshotAsOf(asOf);
  const ev: Evidence = {
    subject: seed.subject,
    asOf,
    kind: seed.kind,
    concept: null,
    fundamentals: null,
    board: null,
    enrichment: null,
    flow: null,
    contradicting: { lossMaking: 0, alreadyUp20: 0, memberTotal: 0, notes: [] },
  };

  // ---- 1) 板块解析 + 成分 + 自身走势 ----
  const board = seed.subjectCode
    ? { code: seed.subjectCode, name: seed.subject, tag: "" }
    : await resolveBoard(seed.subject, snap ?? asOf);

  if (fallback && snap)
    ev.contradicting.notes.push(
      `⚠️ 该日期早于最早的成分快照（${snap}），已退回最早快照 → 轻微前视，仅可用于实盘扫描不可用于历史回测`
    );

  let members: Member[] = [];
  if (board?.code && snap) {
    members = await loadMembers(board.code, asOf, snap);
    ev.board = await boardPerf(board.code, asOf);
  }
  // D2 兜底：题材名映射不到板块 → 直接拿当日涨停的票当证据（不丢卡）
  if (!members.length && seed.kind === "d2_theme") {
    const codes = (seed.metric.codes as string[]) ?? [];
    if (codes.length) {
      const rows: any[] = await prisma.$queryRawUnsafe(
        // 同上：只用 daily_bars，且 c5/c20 取「过去」第 5/20 个交易日
        `SELECT d."tsCode" AS ts_code, k.name, d.close, d.turnover_rate AS turnover, d.amount,
                (SELECT x.close FROM daily_bars x WHERE x."tsCode"=d."tsCode" AND x."tradeDate"<$1
                   ORDER BY x."tradeDate" DESC LIMIT 1)  AS cprev,
                (SELECT x.close FROM daily_bars x WHERE x."tsCode"=d."tsCode" AND x."tradeDate"<$1
                   ORDER BY x."tradeDate" DESC OFFSET 4  LIMIT 1) AS c5,
                (SELECT x.close FROM daily_bars x WHERE x."tsCode"=d."tsCode" AND x."tradeDate"<$1
                   ORDER BY x."tradeDate" DESC OFFSET 19 LIMIT 1) AS c20
         FROM daily_bars d
         LEFT JOIN kpl_list k ON k.ts_code=d."tsCode" AND k.trade_date=d."tradeDate"
         WHERE d."tradeDate"=$1 AND d."tsCode" = ANY($2::text[])`,
        asOf,
        codes
      );
      members = rows.map((r) => {
        const close = r.close != null ? Number(r.close) : null;
        const pct = (x: any) => (close && x != null ? +(((close / Number(x)) - 1) * 100).toFixed(2) : null);
        return {
          ts_code: r.ts_code, name: r.name ?? "", pct1: pct(r.cprev), pct5: pct(r.c5), pct20: pct(r.c20),
          turnover: r.turnover != null ? Number(r.turnover) : null,
          amount: r.amount != null ? Number(r.amount) : null, close,
        };
      });
      ev.contradicting.notes.push("⚠️ 该题材名未映射到任何板块成分，候选仅为当日涨停个股本身");
    }
  }
  ev.concept = { code: board?.code ?? null, members: members.length, listed: members };

  const seedHits = (seed.metric.hits as any[]) ?? [];

  // ---- 1.5) 景气富集度（任何起点都算）----
  if (board?.code && snap) {
    const fromD = new Date(Number(asOf.slice(0,4)), Number(asOf.slice(4,6))-1, Number(asOf.slice(6,8)));
    fromD.setDate(fromD.getDate() - 40);
    const from = `${fromD.getFullYear()}${String(fromD.getMonth()+1).padStart(2,"0")}${String(fromD.getDate()).padStart(2,"0")}`;
    let en = null;
    try {
      en = await computeEnrichment(board.code, asOf, from, snap);
    } catch (e: any) {
      // 🔴 绝不静默吞：算不出来必须看得见，否则"没有结果"和"坏了"分不清
      console.warn(`[thesis] 富集计算失败（${board.code} ${asOf}）：${String(e.message).slice(0, 120)}`);
    }
    if (en) {
      ev.enrichment = { k: en.k, x: en.x, expected: en.expected, enrich: en.enrich, p: en.p };
      if (!seedHits.length && en.hits.length)
        (seed.metric as any).hits = en.hits.map((h: any) => ({ ...h }));
    }
  }

  // ---- 2) 基本面 ----
  let recent: any[] = [];
  if (board?.code && snap) {
    recent = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT ON (f.ts_code) f.ts_code, s.member_name AS name, f.ann_date, f.type, f.summary
       FROM forecast f
       JOIN ths_index_member_snapshots s ON s.ts_code = f.ts_code AND s.thscode = $1 AND s.as_of = $2
       WHERE f.ann_date BETWEEN $3 AND $4 AND f.type IN ('预增','扭亏','略增')
       ORDER BY f.ts_code, f.ann_date DESC LIMIT 20`,
      board.code,
      snap,
      String(seed.metric.from ?? asOf),
      asOf
    );
  }
  ev.fundamentals = {
    hits: seedHits.map((h) => ({ ts_code: h.ts_code, ann_date: h.ann_date, type: h.type, summary: h.summary ?? "" })),
    recent: recent.map((r) => ({ ts_code: r.ts_code, ann_date: r.ann_date, type: r.type, summary: (r.summary ?? "").slice(0, 100) })),
  };

  // ---- 3) 资金流（仅 2024-10 起）----
  const flow: any[] = await prisma.$queryRawUnsafe(
    `SELECT industry, net_amount, pct_change, lead_stock, lead_stock_pct
     FROM industry_moneyflow_ths WHERE trade_date = $1 AND industry = $2 LIMIT 1`,
    asOf,
    seed.subject
  );
  if (flow.length) {
    ev.flow = {
      industry: flow[0].industry,
      net_amount: flow[0].net_amount != null ? Number(flow[0].net_amount) : null,
      pct_change: flow[0].pct_change != null ? Number(flow[0].pct_change) : null,
      lead_stock: flow[0].lead_stock,
      lead_stock_pct: flow[0].lead_stock_pct != null ? Number(flow[0].lead_stock_pct) : null,
    };
  }

  // ---- 4) 反向数据（写反面证据的原料）----
  if (members.length) {
    ev.contradicting.memberTotal = members.length;
    ev.contradicting.alreadyUp20 = members.filter((m) => (m.pct20 ?? 0) > 20).length;
    if (ev.contradicting.lossMaking > members.length)
      ev.contradicting.lossMaking = 0; // 同源保护：负面家数不可能多于成分数（历史快照错配时兜底）
    if (board?.code && snap) {
      const lossMaking: any[] = await prisma.$queryRawUnsafe(
        `SELECT count(DISTINCT f.ts_code)::int AS n
         FROM forecast f
         JOIN ths_index_member_snapshots s ON s.ts_code = f.ts_code AND s.thscode = $1 AND s.as_of = $2
         WHERE f.ann_date >= to_char(to_date($3,'YYYYMMDD') - 180, 'YYYYMMDD')
           AND f.type IN ('首亏','续亏','预减','略减','增亏')`,
        board.code,
        snap,
        asOf
      );
      ev.contradicting.lossMaking = lossMaking[0]?.n ?? 0;
    }
    if (ev.contradicting.lossMaking > 0)
      ev.contradicting.notes.push(
        `同一板块近半年另有 ${ev.contradicting.lossMaking} 家发布负面预告（首亏/续亏/预减）——景气并非全行业`
      );
    if (ev.contradicting.alreadyUp20 > members.length * 0.3)
      ev.contradicting.notes.push(
        `${ev.contradicting.alreadyUp20}/${members.length} 只成分股近 20 日已涨超 20%，论点可能已被 price in`
      );
    if (ev.board?.ret20 != null && ev.board.ret20 > 25)
      ev.contradicting.notes.push(`板块近 20 日已涨 ${ev.board.ret20}%，位置偏高`);
  }

  return ev;
}

// ============================================================
// LLM 叙述（可降级）
// ============================================================
interface LlmCfg { baseUrl: string; apiKey: string; model: string }

/** 服务器是否配了模型 key（供 scripts/thesis-hot.ts 判断「值不值得跑」） */
export function hasServerLlm(): boolean {
  return !!(process.env.THESIS_API_KEY || process.env.AI_SCREEN_API_KEY);
}

function getCfg(): LlmCfg | null {
  const apiKey = process.env.THESIS_API_KEY || process.env.AI_SCREEN_API_KEY;
  if (!apiKey) return null;
  return {
    baseUrl: process.env.THESIS_BASE_URL || process.env.AI_SCREEN_BASE_URL || "https://api.deepseek.com",
    apiKey,
    model: process.env.THESIS_MODEL || process.env.AI_SCREEN_MODEL || "deepseek-v4-flash",
  };
}


export async function narrate(ev: Evidence): Promise<Narrative> {
  const cfg = getCfg();
  const fallback = templateNarrative(ev);
  if (!cfg) return fallback;

  try {
    const { signal, clear } = timeout(120_000);
    const res = await fetch(buildChatUrl(cfg.baseUrl), {
      method: "POST",
      headers: buildLLMHeaders(cfg.apiKey),
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: "system", content: NARRATE_PROMPT },
          { role: "user", content: JSON.stringify(compactEvidence(ev)) },
        ],
        temperature: 0.3,
        // ⚠️ 思考型模型的 max_tokens = 思考 + 正文总预算（见 services/ai-screen/ranker.ts 的教训）。
        // 探针实测：20 token 会被思考全部吃光、正文为空。本任务正文约 600 token，
        // 留 8k 给思考；调大上限不增加花费（只按实际用量计费），但能避免「烧光→正文截断→降级模板」。
        max_tokens: 8192,
        stream: false,
      }),
      signal,
    });
    clear();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: any = await res.json();
    const raw: string = data?.choices?.[0]?.message?.content ?? "";
    const parsed = parseJsonLoose(raw);
    if (!parsed?.thesis) throw new Error("LLM 输出无法解析");
    const counter = String(parsed.counter ?? "").trim();
    if (!counter) {
      // 🔴 反证缺失 → 这张卡无效，退回模板（模板至少带客观反向数据）
      return { ...fallback, thesis: String(parsed.thesis), mispricing: String(parsed.mispricing ?? fallback.mispricing) };
    }
    return {
      thesis: String(parsed.thesis),
      mispricing: String(parsed.mispricing ?? ""),
      counter,
      triggers: Array.isArray(parsed.triggers) ? parsed.triggers.map(String).slice(0, 4) : [],
      llmUsed: true,
    };
  } catch (e: any) {
    console.warn(`[thesis] LLM 叙述失败，降级模板：${String(e.message).slice(0, 80)}`);
    return fallback;
  }
}

function timeout(ms: number) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, clear: () => clearTimeout(t) };
}



/** 无 LLM 时的兜底：论点用客观事实描述，反面证据用反向数据拼 */
export function templateNarrative(ev: Evidence): Narrative {
  const m = ev.concept?.members ?? 0;
  const hits = ev.fundamentals?.hits?.length ?? 0;
  const en = ev.enrichment;
  const thesis =
    ev.kind === "d1_boom"
      ? `${ev.subject} 出现景气聚集：近期 ${hits} 家成分公司发布正面业绩预告`
      : ev.kind === "idea"
        ? `你提出的想法落到板块【${ev.subject}】：${en && en.x > 0 ? `近期 ${en.x} 家成分发布正面预告（富集 ${en.enrich}x）` : "近期没有成分发布正面预告，基本面支撑不足"}`
        : ev.kind === "d2_theme"
          ? `${ev.subject} 题材聚集：当日多只个股涨停，资金向该题材集中`
          : `${ev.subject} 资金流排名跃升`;

  const mispricing = ev.board?.ret20 != null
    ? `板块近 20 日涨幅 ${ev.board.ret20}%（近 250 日 ${ev.board.pctile250 ?? "?"}% 分位）`
    : "（无板块走势数据）";

  const notes = ev.contradicting.notes.slice();
  if (ev.contradicting.memberTotal)
    notes.unshift(`成分共 ${ev.contradicting.memberTotal} 只，其中 ${ev.contradicting.lossMaking} 家近半年负面预告、${ev.contradicting.alreadyUp20} 只近 20 日已涨超 20%`);
  const counter = notes.length
    ? notes.join("；")
    : "⚠️ 未采集到反向数据 —— 本卡反面证据不充分，按纪律应视为无效";

  return { thesis, mispricing, counter, triggers: [], llmUsed: false };
}
