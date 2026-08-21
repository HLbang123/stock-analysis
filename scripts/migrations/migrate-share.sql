-- 自选分享建表（不跑 prisma db push，raw SQL 部署）
-- 用法：npx prisma db execute --file=scripts/migrate-share.sql
-- 分享码=读凭证（明文，公开数据）；owner_token=写鉴权（更新/撤销时校验）

CREATE TABLE IF NOT EXISTS share_snapshots (
  code         VARCHAR(6) PRIMARY KEY,
  owner_token  VARCHAR(64) NOT NULL,
  display_name VARCHAR(20) NOT NULL,
  snapshot     TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_share_snapshots_updated_at ON share_snapshots (updated_at);
