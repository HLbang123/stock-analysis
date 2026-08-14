-- 吸筹箱体预计算表（2026-08-14）
-- 服务器执行：tsx scripts/_run-migration.ts scripts/migrate-stock-box.sql（跑完 prisma generate）
CREATE TABLE IF NOT EXISTS stock_box (
  ts_code      VARCHAR(12) NOT NULL,
  trade_date   VARCHAR(8)  NOT NULL,
  in_box       BOOLEAN NOT NULL DEFAULT FALSE,
  box_quality  DOUBLE PRECISION,
  box_pos      DOUBLE PRECISION,
  box_top      DOUBLE PRECISION,
  box_bottom   DOUBLE PRECISION,
  breakout     BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (ts_code, trade_date)
);
CREATE INDEX IF NOT EXISTS stock_box_trade_date_idx ON stock_box (trade_date);
