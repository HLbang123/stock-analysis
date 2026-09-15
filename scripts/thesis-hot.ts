/**
 * 热点线索兜底：给「≥3 人独立提出」的线索跑一次服务器研判
 *
 * 为什么是这个规则（用户 2026-09-14 定）：
 *   - 用户提交的想法是系统最有价值的输入（定时任务只能从已有数据里找论点，人能提供数据之外的信息）
 *   - 但服务器 key 不能给**每个**用户提交都跑 —— 用户一多就爆
 *   - 「≥3 人独立提出」既把数量压到可控，又恰好是「值得投入」的信号（多人独立想到同一件事）
 *   - 跑一次、所有人看（与每日扫描同一模式）
 *
 * 幂等：靠 hotProposals 里的 NOT EXISTS（已有 narrated_by IN ('api','server') 的卡就不再跑）
 *
 * 运行：npx tsx scripts/thesis-hot.ts [--min=3] [--limit=8]
 */

import "../lib/load-env"; // 必须最先加载：否则读不到 .env.local 里的服务器 key
import { prisma } from "../lib/db";
import { expand, narrate, hasServerLlm } from "../services/thesis/investigate";
import { hotProposals, saveCard, latestTradeDate } from "../services/thesis/pipeline";

function arg(name: string, dflt: number): number {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  return p ? Number(p.slice(name.length + 3)) : dflt;
}

async function main() {
  const min = arg("min", 3);
  const limit = arg("limit", 8);
  const asOf = await latestTradeDate();

  // 🔴 没有服务器 key 就直接退出：本脚本的唯一职责就是「用服务器模型给热点线索补研判」。
  //    否则会每天落一张 template 卡 —— 而 hotProposals 的 NOT EXISTS 只认 api/server，
  //    于是同一条线索天天重跑、天天插卡（卡片刷屏）。
  if (!hasServerLlm()) {
    console.log("[thesis-hot] 未配置服务器模型，跳过（本脚本只做服务器模型兜底）");
    await prisma.$disconnect();
    return;
  }

  const hot = await hotProposals(min);
  if (!hot.length) {
    console.log(`[thesis-hot] 没有「≥${min} 人提出且尚无服务器研判」的线索`);
    await prisma.$disconnect();
    return;
  }
  console.log(`[thesis-hot] ${hot.length} 条热点线索（≥${min} 人提出），本次最多跑 ${limit} 条`);

  let done = 0;
  for (const h of hot.slice(0, limit)) {
    try {
      const seed = {
        kind: "idea" as const,
        subject: h.subject,
        subjectCode: h.subjectCode,
        metric: { idea: h.ideas?.[0] ?? h.subject, to: asOf, proposers: h.proposers },
      };
      const ev = await expand(seed, asOf);
      const na = await narrate(ev);            // ← 这里才用服务器 key，且仅对热点线索
      // 🔴 拿不到真正的模型研判就不落库：宁可不补，也不要制造一张每天重复生成的模板卡
      if (!na.llmUsed) {
        console.warn(`[thesis-hot] ⚠️ ${h.subject} 未取得模型研判，跳过落库（避免卡片刷屏）`);
        continue;
      }
      const cardId = await saveCard({
        subject: h.subject,
        subjectCode: h.subjectCode,
        asOf,
        kind: "idea",
        metric: seed.metric,
        evidence: ev,
        narrative: na,
        narratedBy: "server",
      });
      console.log(`[thesis-hot] ✓ #${cardId} ${h.subject}（${h.proposers} 人提出）`);
      done++;
    } catch (e: any) {
      console.error(`[thesis-hot] ✗ ${h.subject}：${String(e.message).slice(0, 140)}`);
    }
  }
  console.log(`[thesis-hot] 完成 ${done}/${Math.min(hot.length, limit)}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[thesis-hot] 失败:", e);
  prisma.$disconnect().then(() => process.exit(1));
});
