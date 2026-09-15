/**
 * 论点驱动选股 —— CLI 入口
 *
 * 用法（本地必须经 run-local.sh 注入 DATABASE_URL）：
 *   run-local.sh scripts/thesis-scan.ts                       # 系统自动扫描 D1/D2/D3
 *   run-local.sh scripts/thesis-scan.ts --idea="MLCC 涨价"     # 从你的一个想法出发
 *   run-local.sh scripts/thesis-scan.ts --show                # 复查
 *   run-local.sh scripts/thesis-scan.ts --verdict=19 --v=watch --verdict-note="..."
 *
 * 网页端走 /api/thesis，与本脚本共用 services/thesis/pipeline.ts（同一套代码）。
 */

import "../lib/load-env"; // 必须最先加载：否则读不到 .env.local 里的服务器 key
import { prisma } from "../lib/db";
import { detectD1, detectD2, detectD3, type Seed } from "../services/thesis/detect";
import { expand, narrate, type Evidence, type Narrative } from "../services/thesis/investigate";
import { latestTradeDate, resolveIdeaFromText, runInvestigation } from "../services/thesis/pipeline";

const DDL = [
  `ALTER TABLE thesis_cards ADD COLUMN IF NOT EXISTS triggers jsonb`,
  `ALTER TABLE thesis_cards ADD COLUMN IF NOT EXISTS seed_kind varchar(16)`,
  `ALTER TABLE thesis_cards ADD COLUMN IF NOT EXISTS narrated_by varchar(12) DEFAULT 'template'`,
];

function arg(name: string): string | null {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  return p ? p.slice(name.length + 3) : null;
}
const has = (name: string) => process.argv.includes(`--${name}`);

function render(cardId: number, na: Narrative, ev: Evidence, seed: Seed) {
  const L = "─".repeat(76);
  console.log(`\n${L}`);
  console.log(`#${cardId}  【${seed.kind}】${ev.subject}     ${ev.asOf}   ${na.llmUsed ? "" : "（模板）"}`);
  console.log(L);
  console.log(`论点     ${na.thesis}`);
  console.log(`错价假设 ${na.mispricing}`);
  console.log(`🔴 反证  ${na.counter}`);
  if (na.triggers.length) console.log(`盯       ${na.triggers.join(" / ")}`);

  const en = ev.enrichment;
  if (en && ev.kind !== "d2_theme" && ev.kind !== "d3_flow")
    console.log(`\n景气     富集 ${en.enrich}x（命中 ${en.x}/${en.k}，随机预期 ${en.expected}，超几何 p=${en.p}）`);
  for (const h of ev.fundamentals?.hits?.slice(0, 5) ?? [])
    console.log(`         · ${h.ts_code} ${h.ann_date} ${h.type}  ${(h.summary ?? "").slice(0, 66)}`);
  if (ev.kind === "d2_theme")
    console.log(`\n证据     当日 ${seed.metric.count} 只涨停：${(seed.metric.codes as string[]).slice(0, 8).join(" ")}`);
  if (ev.board)
    console.log(`板块     近5日 ${ev.board.ret5}% / 近20日 ${ev.board.ret20}% / 近60日 ${ev.board.ret60}%`);
  if (ev.flow) console.log(`资金     ${ev.flow.industry} 净流入 ${ev.flow.net_amount}  龙头 ${ev.flow.lead_stock}(${ev.flow.lead_stock_pct}%)`);

  const top = (ev.concept?.listed ?? [])
    .filter((m) => m.pct20 != null)
    .sort((a, b) => (b.pct20 ?? 0) - (a.pct20 ?? 0))
    .slice(0, 6);
  if (top.length) {
    console.log(`\n候选     近20日涨幅榜（待调查清单，不是推荐）`);
    for (const m of top)
      console.log(`         ${m.ts_code}  ${(m.name ?? "").padEnd(8)} 今${String(m.pct1 ?? "-").padStart(7)}%  20日${String(m.pct20 ?? "-").padStart(7)}%`);
  }
}

async function show(cardDate?: string) {
  const rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT c.card_id, c.card_date, c.subject, c.thesis, c.mispricing, c.counter,
            c.seed_kind, c.llm_used, c.narrated_by, c.verdict, c.verdict_note
     FROM thesis_cards c
     ${cardDate ? "WHERE c.card_date = $1" : ""}
     ORDER BY c.card_date DESC, c.card_id DESC LIMIT 40`,
    ...(cardDate ? [cardDate] : [])
  );
  if (!rows.length) { console.log("（还没有论点卡）"); return; }
  const L = "─".repeat(76);
  for (const r of rows) {
    console.log(`\n${L}`);
    const who = r.narrated_by === "agent" ? "agent撰写" : r.narrated_by === "api" ? "LLM" : "模板";
    console.log(`#${r.card_id}  【${r.seed_kind ?? "-"}】${r.subject}   ${r.card_date}   ${who}${r.verdict ? `   裁决=${r.verdict}` : ""}`);
    console.log(L);
    console.log(`论点     ${r.thesis ?? "-"}`);
    console.log(`错价假设 ${r.mispricing ?? "-"}`);
    console.log(`🔴 反证  ${r.counter ?? "-"}`);
    if (r.verdict_note) console.log(`你的理由 ${r.verdict_note}`);
  }
}

async function main() {
  for (const sql of DDL) await prisma.$executeRawUnsafe(sql).catch(() => {});

  if (has("show")) { await show(arg("date") ?? undefined); await prisma.$disconnect(); return; }

  const vId = arg("verdict");
  if (vId) {
    await prisma.$executeRawUnsafe(
      `UPDATE thesis_cards SET verdict=$1, verdict_note=$2, verdict_at=now() WHERE card_id=$3`,
      arg("v") ?? "watch", arg("verdict-note") ?? "", Number(vId));
    console.log(`已记录：卡 #${vId} → ${arg("v") ?? "watch"}`);
    await prisma.$disconnect();
    return;
  }

  const asOf = arg("date") ?? (await latestTradeDate());
  const idea = arg("idea");

  let seeds: Seed[] = [];
  if (idea) {
    const hit = await resolveIdeaFromText(idea);
    if (!hit) {
      console.error(`❌ 无法把「${idea}」映射到任何板块或题材。换个说法。`);
      await prisma.$disconnect();
      process.exit(1);
    }
    console.log(`由点及面：「${idea}」→ 板块【${hit.subject}】（${hit.how}）`);
    seeds = [{ kind: "idea", subject: hit.subject, subjectCode: hit.code, metric: { idea, to: asOf } }];
  } else {
    console.log(`扫描 ${asOf} 的论点起点…`);
    const [d1, d2, d3] = await Promise.all([
      detectD1(asOf).catch((e) => { console.error(`D1 失败: ${e.message}`); return [] as Seed[]; }),
      detectD2(asOf).catch((e) => { console.error(`D2 失败: ${e.message}`); return [] as Seed[]; }),
      detectD3(asOf).catch((e) => { console.error(`D3 失败: ${e.message}`); return [] as Seed[]; }),
    ]);
    console.log(`D1 景气聚类 ${d1.length} 个 / D2 题材聚集 ${d2.length} 个 / D3 资金流跃升 ${d3.length} 个`);
    seeds = [...d1.slice(0, 4), ...d2.slice(0, 3), ...d3.slice(0, 2)];
  }

  if (!seeds.length) {
    console.log("今日没有触发任何起点（阈值未过）。这是正常的——不是每天都有论点。");
    await prisma.$disconnect();
    return;
  }

  let ok = 0;
  for (const s of seeds) {
    try {
      const ev = await expand(s, asOf);
      const na = await narrate(ev);
      const { cardId } = await runInvestigation(s, asOf);
      render(cardId, na, ev, s);
      ok++;
    } catch (e: any) {
      console.error(`✗ ${s.subject} 调查失败：${String(e.message).slice(0, 140)}`);
    }
  }
  console.log(`\n共生成 ${ok}/${seeds.length} 张论点卡。用 --show 复查，--verdict=ID --v=buy|watch|skip 拍板。`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[thesis-scan] 失败:", e);
  prisma.$disconnect().then(() => process.exit(1));
});
