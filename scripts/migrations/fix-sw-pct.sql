-- 一次性修复：sw_index_daily.pct_chg 全表 NULL（Tushare sw_daily 接口该字段长期为空）
-- 用 close 序列 LAG 推算涨跌幅，幂等可重跑。
-- 运行：npx prisma db execute --file=scripts/fix-sw-pct.sql
WITH ordered AS (
  SELECT ts_code, trade_date, close,
         LAG(close) OVER (PARTITION BY ts_code ORDER BY trade_date) AS prev_close
  FROM sw_index_daily
)
UPDATE sw_index_daily d
SET pct_chg = ROUND(((o.close / NULLIF(o.prev_close, 0) - 1) * 100)::numeric, 4)
FROM ordered o
WHERE o.ts_code = d.ts_code AND o.trade_date = d.trade_date AND o.prev_close IS NOT NULL;
