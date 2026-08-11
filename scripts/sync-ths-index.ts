/**
 * 同花顺指数（概念/行业）清单 + 成分股同步（fuyao 源）
 *
 * 拉取 cn_concept（概念，约390个）+ industry（行业，881一级+884二级）两个 tag 的
 * 指数清单，再逐指数拉成分股，全量覆盖式刷新 ths_index / ths_index_member。
 *
 * 与申万口径（sw_index_member，sync-sw-member.ts 维护）并存：
 *   申万=券商行业分类（scanner 行业过滤用）；同花顺=概念板块+行业（概念标签、
 *   与 industry_moneyflow_ths 行业名同源）。
 *
 * 运行：npx tsx scripts/sync-ths-index.ts [--tag=industry|cn_concept]
 *   默认两个 tag 都刷；--tag 只刷一个。约 520 个指数 × 1 次调用，限速 250ms ≈ 3 分钟。
 *   成分股为「当前快照」，每日盘后跑一次即可（run-daily 可挂）。
 */

import { prisma } from "../lib/db";
import { getThsIndexList, getThsConstituents, type ThsIndexTag } from "../lib/fuyao";

const SLEEP_MS = 250; // fuyao 客户端无内置限速，脚本侧自律
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function syncTag(tag: ThsIndexTag): Promise<{ indices: number; members: number }> {
  const list = await getThsIndexList(tag);
  const items = list.item || [];
  console.log(`[sync-ths-index] tag=${tag}：${items.length} 个指数`);

  let memberTotal = 0;
  for (let i = 0; i < items.length; i++) {
    const idx = items[i];
    try {
      // 指数本体 upsert
      await prisma.thsIndex.upsert({
        where: { thscode: idx.thscode },
        create: { thscode: idx.thscode, name: idx.name, tag },
        update: { name: idx.name, tag, updatedAt: new Date() },
      });

      // 成分股全量覆盖：先删后插（成员增删都生效，免 diff）
      const cons = await getThsConstituents(idx.thscode);
      const members = (cons.item || []).filter((m) => m.thscode);
      await prisma.thsIndexMember.deleteMany({ where: { thscode: idx.thscode } });
      for (let j = 0; j < members.length; j += 500) {
        await prisma.thsIndexMember.createMany({
          data: members.slice(j, j + 500).map((m) => ({
            thscode: idx.thscode,
            tsCode: m.thscode,
            memberName: m.name ?? null,
          })),
        });
      }
      memberTotal += members.length;
    } catch (e: any) {
      console.error(`[sync-ths-index] ${idx.thscode} ${idx.name} 失败: ${e.message?.slice(0, 100)}`);
    }
    if ((i + 1) % 20 === 0 || i === items.length - 1) {
      console.log(`[sync-ths-index] tag=${tag} ${i + 1}/${items.length}，累计成分 ${memberTotal} 条`);
    }
    await sleep(SLEEP_MS);
  }
  return { indices: items.length, members: memberTotal };
}

async function main() {
  const tagArg = process.argv.find((a) => a.startsWith("--tag="))?.split("=")[1] as ThsIndexTag | undefined;
  const tags: ThsIndexTag[] = tagArg ? [tagArg] : ["industry", "cn_concept"];

  for (const tag of tags) {
    const r = await syncTag(tag);
    console.log(`[sync-ths-index] tag=${tag} 完成：${r.indices} 指数 / ${r.members} 成分`);
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[sync-ths-index] 失败:", e);
  prisma.$disconnect().then(() => process.exit(1));
});
