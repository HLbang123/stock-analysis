-- 2026-08-10 daily_bars 加复权因子列（tushare adj_factor，上市起累计因子）
-- 用途：窗口涨幅/均线/RPS 等多日计算改用 close*adj_factor（后复权），消除除权除息假跳空。
-- 展示口径（最新价/价格过滤）仍用原始 close。
-- 执行后：
--   1) npx prisma generate（本地重新生成 client）
--   2) npx tsx scripts/sync-daily.ts --backfill-adj   （回补历史全部交易日因子，约600次调用）
--   3) 重跑 RPS：npx tsx scripts/compute-rps.ts && npx tsx scripts/backfill-rps.ts --days=80
ALTER TABLE daily_bars ADD COLUMN IF NOT EXISTS adj_factor DOUBLE PRECISION;
