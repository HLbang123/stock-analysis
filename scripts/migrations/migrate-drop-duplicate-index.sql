-- 2026-08-15 删除 daily_bars 上重复的 tradeDate 索引
-- 现状：daily_bars 有两条 btree("tradeDate")——
--   1) daily_bars_tradeDate_idx（schema.prisma @@index([tradeDate])，保留）
--   2) idx_daily_bars_date（init.sql 遗留，冗余，删除）
-- 保留 schema.prisma 对应的那条，与未来 prisma db push 一致。
-- 执行：npx prisma db execute --file=scripts/migrate-drop-duplicate-index.sql
DROP INDEX IF EXISTS idx_daily_bars_date;
