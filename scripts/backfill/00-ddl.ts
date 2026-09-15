/**
 * 00 建表 —— 执行 scripts/backfill/_schema.sql
 * 用法：bash scripts/_scratch/run-local.sh scripts/backfill/00-ddl.ts
 */
import { runDdl } from "./_lib";
import { prisma } from "../../lib/db";

runDdl()
  .then(async () => {
    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_name IN
       ('ingest_progress','limit_list','kpl_list','top_list','top_inst','news_title',
        'hm_list','announcements','forecast','express','holder_trade','share_float',
        'repurchase','suspend','stk_alert','block_trade','dividend','industry_moneyflow_dc')
       ORDER BY 1`
    );
    console.log(`[ddl] 已就绪表 ${rows.length} 张: ${rows.map((r) => r.table_name).join(", ")}`);
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error("[ddl] 失败:", e);
    await prisma.$disconnect();
    process.exit(1);
  });
