-- 2026-08-05 market_breadth 加 RPS60 改善占比列（RPS≥87 占比已证伪移除）
-- 执行：npx prisma db execute --file=scripts/migrate-rps-improve.sql
ALTER TABLE market_breadth ADD COLUMN IF NOT EXISTS rps_improve_ratio DOUBLE PRECISION;
