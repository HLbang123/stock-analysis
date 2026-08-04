-- P3：DeepAnalysisRecord 加 market_regime 列（分析时大盘环境 strong/neutral/weak）
-- 部署：npx prisma db execute --file=scripts/migrate-deep-analysis-regime.sql
-- 旧数据为 NULL，stats 归入 unknown 桶；不跑 prisma db push（daily_bars 孤儿数据会卡外键）
ALTER TABLE deep_analysis_records ADD COLUMN IF NOT EXISTS market_regime VARCHAR(8);
