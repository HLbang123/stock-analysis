-- 2026-08-10 同花顺指数（概念/行业）与成分股表（fuyao 源，scripts/sync-ths-index.ts 维护）
-- 用途：个股概念标签（详情页/深度分析）、板块口径统一（与 industry_moneyflow_ths 行业名同源）。
-- 执行后：npx prisma generate && npx tsx scripts/sync-ths-index.ts
CREATE TABLE IF NOT EXISTS ths_index (
  thscode    VARCHAR(12) PRIMARY KEY,
  name       VARCHAR(50) NOT NULL,
  tag        VARCHAR(20) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ths_index_member (
  thscode     VARCHAR(12) NOT NULL REFERENCES ths_index(thscode) ON DELETE CASCADE,
  ts_code     VARCHAR(12) NOT NULL,
  member_name VARCHAR(40),
  PRIMARY KEY (thscode, ts_code)
);
CREATE INDEX IF NOT EXISTS ths_index_member_ts_code_idx ON ths_index_member (ts_code);
