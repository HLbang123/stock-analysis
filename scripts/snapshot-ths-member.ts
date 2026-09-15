/**
 * 同花顺板块成分 PIT 快照（point-in-time）
 *
 * 解决什么问题：
 *   `ths_index_member` 是「当前成分快照」——`sync-ths-index.ts` 每周一先删后插全量覆盖，
 *   表里没有生效日期。用它回测概念板块（如 MLCC）会有**前视偏差**：
 *   今天还在某概念里的股票，正是该题材里活到今天的赢家，回测会系统性高估。
 *   390 个概念板块平均每股属 12.66 个概念且成分剧烈变动，这个偏差不可忽略。
 *   → 详见 docs/sector-layer-alpha.md「坑 2」与 docs/selection-literature-review.md
 *
 * 做法：
 *   每周一 `sync-ths-index.ts` 刷新完成**之后**，把当时的全量成分打一份带 `as_of` 的快照。
 *   回测时取 `as_of <= 目标日` 的最新一份，即为「当时可知道的成分」。
 *
 *   ⚠️ 只能从现在开始攒，**补不了历史**。越早开始越是长期资产。
 *
 * 幂等与去重：
 *   若当前成分与 `as_of` 当天已存的快照内容一致 → 跳过（不产生重复行）。
 *   若当天已存快照但内容变了（同日重跑）→ 删除当天快照后重写。
 *   → 成分没有实际变化时，表不会增长。
 *
 * 运行：
 *   npx tsx scripts/snapshot-ths-member.ts              # as_of = 今天（北京时间）
 *   npx tsx scripts/snapshot-ths-member.ts --as-of=20260914
 *   npx tsx scripts/snapshot-ths-member.ts --force      # 内容相同也重写
 *
 * 表自举：本脚本自带 CREATE TABLE IF NOT EXISTS，本地/服务器首次运行即可，无需单独迁移。
 */

import { prisma } from "../lib/db";

const TABLE = "ths_index_member_snapshots";

const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS ${TABLE} (
     as_of       varchar(8)  NOT NULL,
     thscode     varchar(12) NOT NULL,
     ts_code     varchar(12) NOT NULL,
     member_name varchar(40),
     tag         varchar(20),
     PRIMARY KEY (as_of, thscode, ts_code)
   )`,
  `CREATE INDEX IF NOT EXISTS ths_member_snap_asof ON ${TABLE} (as_of)`,
  `CREATE INDEX IF NOT EXISTS ths_member_snap_code ON ${TABLE} (ts_code, as_of)`,
];

/** 北京时间当天 YYYYMMDD（日任务 16:00 CST 跑，UTC 日期与 CST 同日，但仍显式换算以免边界出错） */
function todayCst(): string {
  const cst = new Date(Date.now() + 8 * 3600 * 1000);
  return cst.toISOString().slice(0, 10).replace(/-/g, "");
}

/** 当前成分全表的指纹（与快照同口径构造 key，保证可比） */
async function currentHash(): Promise<string> {
  const rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT md5(string_agg(k, ',' ORDER BY k)) AS h FROM (
       SELECT m.thscode || ':' || m.ts_code || ':' || COALESCE(m.member_name, '') || ':' || COALESCE(i.tag, '') AS k
       FROM ths_index_member m
       JOIN ths_index i ON i.thscode = m.thscode
     ) x`
  );
  return rows[0]?.h ?? "";
}

async function snapshotHash(asOf: string): Promise<string | null> {
  const rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT md5(string_agg(k, ',' ORDER BY k)) AS h FROM (
       SELECT thscode || ':' || ts_code || ':' || COALESCE(member_name, '') || ':' || COALESCE(tag, '') AS k
       FROM ${TABLE} WHERE as_of = $1
     ) x`,
    asOf
  );
  const h = rows[0]?.h ?? null;
  return h;
}

async function countAsOf(asOf: string): Promise<number> {
  const rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM ${TABLE} WHERE as_of = $1`,
    asOf
  );
  return rows[0]?.n ?? 0;
}

async function main() {
  const asOf =
    process.argv.find((a) => a.startsWith("--as-of="))?.split("=")[1] || todayCst();
  const force = process.argv.includes("--force");

  if (!/^\d{8}$/.test(asOf)) throw new Error(`as_of 格式须为 YYYYMMDD，收到：${asOf}`);

  for (const sql of DDL) await prisma.$executeRawUnsafe(sql);

  // 数据源为空时不要写空快照（否则会污染 PIT 查询）
  const src: any[] = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n,
            (SELECT count(*)::int FROM ths_index) AS boards
     FROM ths_index_member`
  );
  const srcRows: number = src[0]?.n ?? 0;
  const srcBoards: number = src[0]?.boards ?? 0;
  if (srcRows === 0) {
    console.error("[snapshot-ths] ths_index_member 为空，拒绝写空快照");
    await prisma.$disconnect();
    process.exit(1);
  }

  const [cur, prev, existing] = await Promise.all([
    currentHash(),
    snapshotHash(asOf),
    countAsOf(asOf),
  ]);

  console.log(
    `[snapshot-ths] as_of=${asOf} 当前成分 ${srcRows} 条 / ${srcBoards} 板块` +
      (existing > 0 ? `，当天已有快照 ${existing} 条` : "")
  );

  if (existing > 0 && prev === cur && !force) {
    console.log("[snapshot-ths] 成分无变化，跳过（表不增长）");
    await prisma.$disconnect();
    return;
  }

  if (existing > 0) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${TABLE} WHERE as_of = $1`, asOf);
    console.log(`[snapshot-ths] 当天快照内容已变化，删除 ${existing} 条后重写`);
  }

  const inserted: number = await prisma.$executeRawUnsafe(
    `INSERT INTO ${TABLE} (as_of, thscode, ts_code, member_name, tag)
     SELECT $1, m.thscode, m.ts_code, m.member_name, i.tag
     FROM ths_index_member m
     JOIN ths_index i ON i.thscode = m.thscode
     ON CONFLICT (as_of, thscode, ts_code) DO NOTHING`,
    asOf
  );

  const byTag: any[] = await prisma.$queryRawUnsafe(
    `SELECT COALESCE(tag, '(null)') AS tag, count(*)::int AS n
     FROM ${TABLE} WHERE as_of = $1 GROUP BY 1 ORDER BY n DESC`,
    asOf
  );
  const totals: any[] = await prisma.$queryRawUnsafe(
    `SELECT count(DISTINCT as_of)::int AS snaps, min(as_of) AS first, max(as_of) AS last
     FROM ${TABLE}`
  );

  console.log(`[snapshot-ths] ✓ 写入 ${inserted} 条`);
  for (const r of byTag) console.log(`[snapshot-ths]   ${r.tag}: ${r.n}`);
  console.log(
    `[snapshot-ths] 累计 ${totals[0]?.snaps ?? 0} 份快照，` +
      `${totals[0]?.first ?? "-"} ~ ${totals[0]?.last ?? "-"}`
  );

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[snapshot-ths] 失败:", e);
  prisma.$disconnect().then(() => process.exit(1));
});
