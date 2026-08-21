-- 2026-08-11 daily_briefs 表（盘前提示 morning / 盘后日报 daily）
-- 执行：npx prisma db execute --file=scripts/migrate-daily-brief.sql
CREATE TABLE IF NOT EXISTS daily_briefs (
  id          VARCHAR(36) PRIMARY KEY,
  brief_date  VARCHAR(8)  NOT NULL,
  type        VARCHAR(8)  NOT NULL, -- morning=盘前提示 / daily=盘后日报
  payload     TEXT        NOT NULL,
  created_at  VARCHAR(32) NOT NULL,
  UNIQUE (brief_date, type)
);
CREATE INDEX IF NOT EXISTS daily_briefs_date_idx ON daily_briefs (brief_date);
