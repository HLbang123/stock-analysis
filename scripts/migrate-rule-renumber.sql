-- 2026-08-05 规则重排：移除 R04 妇联定律后，R05-R15 顺移为 R04-R14
-- 历史触发记录（alert_rule_triggers）同步迁移，保持健康面板/周报统计口径连续
-- 执行：npx prisma db execute --file=scripts/migrate-rule-renumber.sql

UPDATE alert_rule_triggers SET rule_id = CASE rule_id
  WHEN 'R05' THEN 'R04' WHEN 'R06' THEN 'R05' WHEN 'R07' THEN 'R06'
  WHEN 'R08' THEN 'R07' WHEN 'R09' THEN 'R08' WHEN 'R10' THEN 'R09'
  WHEN 'R11' THEN 'R10' WHEN 'R12' THEN 'R11' WHEN 'R13' THEN 'R12'
  WHEN 'R14' THEN 'R13' WHEN 'R15' THEN 'R14'
  ELSE rule_id END;
