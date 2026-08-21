-- 云同步建表（不跑 prisma db push，raw SQL 部署，见 scripts/migrate-ai-screen-eval.sql 惯例）
-- 用法：npx prisma db execute --file=scripts/migrate-sync.sql

CREATE TABLE IF NOT EXISTS sync_snapshots (
  sync_id    VARCHAR(36) PRIMARY KEY,
  key_hash   VARCHAR(64) NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  blob       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sync_pairings (
  code_hash   VARCHAR(64) PRIMARY KEY,
  sync_id     VARCHAR(36) NOT NULL,
  wrapped_key TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_pairings_sync_id ON sync_pairings (sync_id);
CREATE INDEX IF NOT EXISTS idx_sync_snapshots_updated_at ON sync_snapshots (updated_at);
