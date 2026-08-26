/**
 * 复盘日历 + 宽基指数日线 建表迁移
 * 用 raw SQL（CREATE TABLE IF NOT EXISTS）绕过 prisma db push 禁令。
 * 表结构同步在 database/init.sql 与 scripts/migrations/migrate-review-calendar-tables.sql。
 *
 * 用法（服务器）：npx tsx scripts/migrate-review-calendar-tables.ts
 */

import { prisma } from "../lib/db";

const DDL = [
  `CREATE TABLE IF NOT EXISTS index_daily (
    ts_code    VARCHAR(12) NOT NULL,
    trade_date VARCHAR(8)  NOT NULL,
    open       DOUBLE PRECISION,
    high       DOUBLE PRECISION,
    low        DOUBLE PRECISION,
    close      DOUBLE PRECISION,
    pct_chg    DOUBLE PRECISION,
    vol        DOUBLE PRECISION,
    amount     DOUBLE PRECISION,
    PRIMARY KEY (ts_code, trade_date)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_index_daily_date ON index_daily(trade_date)`,
  `CREATE TABLE IF NOT EXISTS review_calendar_days (
    trade_date      VARCHAR(8) PRIMARY KEY,
    total_amount    DOUBLE PRECISION,
    advance         INTEGER,
    decline         INTEGER,
    flat            INTEGER,
    limit_up        INTEGER,
    limit_down      INTEGER,
    amount_ma20     DOUBLE PRECISION,
    volume_ratio    DOUBLE PRECISION,
    vol_pctile_60d  DOUBLE PRECISION,
    vol_pctile_120d DOUBLE PRECISION,
    up_pctile_60d   DOUBLE PRECISION,
    up_pctile_120d  DOUBLE PRECISION,
    idx_pct_chg     DOUBLE PRECISION,
    is_ice_point    BOOLEAN,
    ice_level       VARCHAR(12),
    ice_confidence  VARCHAR(8),
    regime          VARCHAR(8),
    regime_day      INTEGER
  )`,
  `ALTER TABLE review_calendar_days ADD COLUMN IF NOT EXISTS regime VARCHAR(8)`,
  `ALTER TABLE review_calendar_days ADD COLUMN IF NOT EXISTS regime_day INTEGER`,
];

async function main() {
  for (const sql of DDL) {
    await prisma.$executeRawUnsafe(sql);
    console.log("[migrate] done:", sql.split("\n")[0].replace(/^\s*/, ""));
  }
  console.log("[migrate] 全部完成");
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[migrate] 失败:", e.message);
  await prisma.$disconnect();
  process.exit(1);
});
