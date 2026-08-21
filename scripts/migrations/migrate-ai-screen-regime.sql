-- AI 筛选：run 级市场状态标记（2026-08-14）
-- 服务器执行：tsx scripts/_run-migration.ts scripts/migrate-ai-screen-regime.sql（跑完 prisma generate）
ALTER TABLE ai_screen_runs ADD COLUMN IF NOT EXISTS market_regime VARCHAR(12);
