-- 短线策略候选快照表迁移（raw SQL，服务器部署用，勿跑 prisma db push）
-- 应用方式（服务器）：npx tsx scripts/migrate-short-term-tables.ts
-- 或本地有 psql 时：psql -f 本文件

CREATE TABLE IF NOT EXISTS short_term_signals (
  id           VARCHAR(36) PRIMARY KEY,
  strategy     VARCHAR(32) NOT NULL,  -- limit-up-three-yin / dragon-first-yin / double-dragon
  phase        VARCHAR(16) NOT NULL,  -- closing / morning
  trade_date   VARCHAR(8)  NOT NULL,  -- YYYYMMDD 快照基准交易日
  ts_code      VARCHAR(12) NOT NULL,
  name         VARCHAR(40),
  signal_type  VARCHAR(24) NOT NULL,  -- firstYinToday / firstYinYesterday / limit_up_three_yin / double_dragon_board / double_dragon_pullback
  matched_date VARCHAR(10) NOT NULL,  -- YYYY-MM-DD 形态触发日
  priority     VARCHAR(8)  NOT NULL,  -- high / medium / low
  reason       VARCHAR(200),
  summary      VARCHAR(300),
  metrics      JSONB,
  created_at   VARCHAR(32) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_short_term_signals_lookup ON short_term_signals (strategy, phase, trade_date);
CREATE UNIQUE INDEX IF NOT EXISTS uq_short_term_signals ON short_term_signals (strategy, phase, trade_date, ts_code, signal_type);
