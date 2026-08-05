-- 预警触发明细 + 周回顾快照（2026-08-05）
-- 部署：npx prisma db execute --file=scripts/migrate-alert-health.sql
-- 不跑 prisma db push（daily_bars 孤儿数据会卡外键）
CREATE TABLE IF NOT EXISTS alert_rule_triggers (
  id          VARCHAR(36) PRIMARY KEY,
  stock_code  VARCHAR(12) NOT NULL,
  stock_name  VARCHAR(40),
  rule_id     VARCHAR(8) NOT NULL,
  sub_label   VARCHAR(24) NOT NULL,
  bar_date    VARCHAR(8) NOT NULL,
  created_at  VARCHAR(32) NOT NULL,
  params      VARCHAR(200),
  t5_return   DOUBLE PRECISION,
  t10_return  DOUBLE PRECISION,
  source      VARCHAR(8) NOT NULL DEFAULT 'online',
  UNIQUE (stock_code, rule_id, sub_label, bar_date, source)
);
CREATE INDEX IF NOT EXISTS idx_alert_triggers_bardate ON alert_rule_triggers (bar_date);
CREATE INDEX IF NOT EXISTS idx_alert_triggers_sublabel ON alert_rule_triggers (sub_label);

CREATE TABLE IF NOT EXISTS weekly_reviews (
  id         VARCHAR(36) PRIMARY KEY,
  week_start VARCHAR(8) NOT NULL,
  payload    TEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  UNIQUE (week_start)
);

-- 波段评分(做T)信号在线落库（2026-08-05）
CREATE TABLE IF NOT EXISTS tscore_records (
  id              VARCHAR(36) PRIMARY KEY,
  stock_code      VARCHAR(12) NOT NULL,
  stock_name      VARCHAR(40),
  trade_date      VARCHAR(8) NOT NULL,
  minute_of_day   INTEGER,
  price           DOUBLE PRECISION,
  buy_score       DOUBLE PRECISION,
  sell_score      DOUBLE PRECISION,
  buy_factors     TEXT,
  sell_factors    TEXT,
  degraded        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      VARCHAR(32) NOT NULL,
  intraday_return DOUBLE PRECISION,
  next_day_return DOUBLE PRECISION,
  UNIQUE (stock_code, trade_date, minute_of_day)
);
CREATE INDEX IF NOT EXISTS idx_tscore_tradedate ON tscore_records (trade_date);

-- 同花顺 THS 口径数据（2026-08-05）：个股资金流 / 行业资金流 / 基金日线
CREATE TABLE IF NOT EXISTS stock_moneyflow_ths (
  ts_code VARCHAR(12) NOT NULL,
  trade_date VARCHAR(8) NOT NULL,
  name VARCHAR(40),
  pct_change DOUBLE PRECISION,
  latest DOUBLE PRECISION,
  net_amount DOUBLE PRECISION,
  net_d5_amount DOUBLE PRECISION,
  buy_lg_amount DOUBLE PRECISION,
  buy_lg_amount_rate DOUBLE PRECISION,
  buy_md_amount DOUBLE PRECISION,
  buy_md_amount_rate DOUBLE PRECISION,
  buy_sm_amount DOUBLE PRECISION,
  buy_sm_amount_rate DOUBLE PRECISION,
  PRIMARY KEY (ts_code, trade_date)
);
CREATE INDEX IF NOT EXISTS idx_mf_ths_date ON stock_moneyflow_ths (trade_date);

CREATE TABLE IF NOT EXISTS industry_moneyflow_ths (
  ts_code VARCHAR(12) NOT NULL,
  trade_date VARCHAR(8) NOT NULL,
  industry VARCHAR(40),
  lead_stock VARCHAR(40),
  close DOUBLE PRECISION,
  pct_change DOUBLE PRECISION,
  company_num INTEGER,
  net_buy_amount DOUBLE PRECISION,
  net_sell_amount DOUBLE PRECISION,
  net_amount DOUBLE PRECISION,
  PRIMARY KEY (ts_code, trade_date)
);
CREATE INDEX IF NOT EXISTS idx_indmf_ths_date ON industry_moneyflow_ths (trade_date);

CREATE TABLE IF NOT EXISTS fund_daily_bars (
  ts_code VARCHAR(12) NOT NULL,
  trade_date VARCHAR(8) NOT NULL,
  open DOUBLE PRECISION,
  high DOUBLE PRECISION,
  low DOUBLE PRECISION,
  close DOUBLE PRECISION,
  pre_close DOUBLE PRECISION,
  change_pct DOUBLE PRECISION,
  vol DOUBLE PRECISION,
  amount DOUBLE PRECISION,
  PRIMARY KEY (ts_code, trade_date)
);
CREATE INDEX IF NOT EXISTS idx_fund_daily_date ON fund_daily_bars (trade_date);

-- 涨跌停价（stk_limit，2026-08-05）
CREATE TABLE IF NOT EXISTS stock_limits (
  ts_code VARCHAR(12) NOT NULL,
  trade_date VARCHAR(8) NOT NULL,
  pre_close DOUBLE PRECISION,
  limit_up DOUBLE PRECISION,
  limit_down DOUBLE PRECISION,
  PRIMARY KEY (ts_code, trade_date)
);
CREATE INDEX IF NOT EXISTS idx_stock_limits_date ON stock_limits (trade_date);
