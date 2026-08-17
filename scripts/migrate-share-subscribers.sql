-- 2026-08-17 分享订阅人数统计
-- 订阅端本地随机 ID 去重登记；只统计人数，不记录任何订阅者身份。
-- 执行：npx prisma db execute --file=scripts/migrate-share-subscribers.sql
CREATE TABLE IF NOT EXISTS share_subscribers (
  code          VARCHAR(6)  NOT NULL,
  subscriber_id VARCHAR(32) NOT NULL,
  created_at    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT share_subscribers_pkey PRIMARY KEY (code, subscriber_id)
);
CREATE INDEX IF NOT EXISTS share_subscribers_code_idx ON share_subscribers (code);
