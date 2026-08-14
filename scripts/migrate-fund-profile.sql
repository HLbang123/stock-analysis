-- 2026-08-14 新增 fund_profiles：ETF 品种档案（tushare fund_basic + 派生分类）
-- 用途：ETF 注册表唯一事实源（sync-fund-daily 清单源）；品种分类(asset_class/t_plus0/limit_pct)
--       供预警规则口径分层、T-score ETF profile、深度分析 ETF 数据块消费。
-- 执行后：
--   1) npx prisma generate（本地重新生成 client）
--   2) npx tsx scripts/sync-fund-profiles.ts --init   （灌全量 ETF 注册表，约 900 只）
CREATE TABLE IF NOT EXISTS fund_profiles (
  ts_code      VARCHAR(12) PRIMARY KEY,
  name         VARCHAR(40)  NOT NULL,
  fund_type    VARCHAR(20),
  invest_type  VARCHAR(20),
  benchmark    VARCHAR(120),
  list_date    VARCHAR(8),
  delist_date  VARCHAR(8),
  asset_class  VARCHAR(16),
  t_plus0      BOOLEAN      NOT NULL DEFAULT FALSE,
  limit_pct    INTEGER,
  is_active    BOOLEAN      NOT NULL DEFAULT TRUE
);
