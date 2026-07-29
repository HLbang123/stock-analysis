-- AI 筛选胜率重构迁移(raw SQL,服务器部署用,勿跑 prisma db push)
-- 对应 prisma/schema.prisma 的 AiScreenPick 改动 + 新 AiScreenEval 表

-- 1. ai_screen_picks 加 selected 列 + rank 可空 + 3 个技术字段
ALTER TABLE ai_screen_picks ADD COLUMN IF NOT EXISTS selected boolean DEFAULT false;
ALTER TABLE ai_screen_picks ALTER COLUMN rank DROP NOT NULL;
ALTER TABLE ai_screen_picks ADD COLUMN IF NOT EXISTS ma_bullish boolean;
ALTER TABLE ai_screen_picks ADD COLUMN IF NOT EXISTS pullback_to_ma20_pct double precision;
ALTER TABLE ai_screen_picks ADD COLUMN IF NOT EXISTS breakout_20d_pct double precision;
CREATE INDEX IF NOT EXISTS ai_screen_picks_selected_idx ON ai_screen_picks (selected);

-- 2. 历史数据回填 selected(旧 run 全员有 rank,视为入选)
UPDATE ai_screen_picks SET selected = true WHERE rank IS NOT NULL AND selected = false;

-- 3. 新建 ai_screen_evals(T+N 多持有期回测)
CREATE TABLE IF NOT EXISTS ai_screen_evals (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  pick_id varchar(36) NOT NULL REFERENCES ai_screen_picks(id) ON DELETE CASCADE,
  n_days int NOT NULL,
  exit_price double precision,
  exit_date varchar(8),
  return_pct double precision,
  cost_bps double precision DEFAULT 0,
  shape_status varchar(32),
  max_drawdown_pct double precision,
  max_runup_pct double precision,
  path_status varchar(24),
  UNIQUE (pick_id, n_days)
);
CREATE INDEX IF NOT EXISTS ai_screen_evals_n_days_idx ON ai_screen_evals (n_days);
