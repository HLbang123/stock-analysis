-- 意见反馈表（首页汉堡菜单「意见反馈」提交；文本 + 可选截图，截图为 data URL 数组 JSONB）
-- 用法：npx tsx scripts/_run-migration.ts scripts/migrations/migrate-feedback.sql
CREATE TABLE IF NOT EXISTS feedbacks (
    id         VARCHAR(36) PRIMARY KEY,
    content    TEXT NOT NULL,
    contact    VARCHAR(80),
    images     JSONB,
    meta       JSONB,
    status     VARCHAR(16) NOT NULL DEFAULT 'new',
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_feedbacks_created_at ON feedbacks(created_at DESC);
