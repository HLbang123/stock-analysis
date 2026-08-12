-- 资金流向 THS 表加超大单字段（同花顺 App"主力"=超大单+大单，此前缺 elg 只能用全量净额冒充主力）
-- 用法：npx prisma db execute --file=scripts/migrate-moneyflow-elg.sql
ALTER TABLE stock_moneyflow_ths
  ADD COLUMN IF NOT EXISTS buy_elg_amount DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS buy_elg_amount_rate DOUBLE PRECISION;
