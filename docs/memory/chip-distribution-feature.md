---
name: chip-distribution-feature
description: 筹码峰功能（路线B换手率转移模型）已实现——lib/chip.ts单一事实源+AI筛选chip因子+R18/R19弱提醒+AI分析注入
metadata: 
  node_type: memory
  type: project
  modified: 2026-07-28T08:54:13.020Z
  originSessionId: e9df12ba-ffea-423f-8689-f692804e5dec
---

筹码峰（筹码分布）功能已实现（2026-07-28）。路线 B 换手率转移模型（陈浩《筹码分布》），非固定衰减近似。

## 数据层（Phase 0）
- `daily_bars` 加 `turnover_rate`（换手率%，筹码模型唯一硬需求）+ `circ_mv`（流通市值万元，备用）。
- schema.prisma DailyBar + database/init.sql 已加列；**生产需手跑 `ALTER TABLE daily_bars ADD COLUMN turnover_rate DOUBLE PRECISION, ADD COLUMN circ_mv DOUBLE PRECISION;`**（别 prisma db push，孤儿会卡）。
- `scripts/sync-daily.ts`：`syncDate()` 内 `daily` 后追加 `daily_basic(trade_date)` 调用合并；**冲突策略由 DO NOTHING 改 DO UPDATE**（否则增量不刷新新列）；加 `--backfill-chip` 模式回补历史缺 turnover_rate 的交易日。

## 计算核心（Phase 1，单一事实源）
- `lib/chip.ts`：`computeChipDistribution(bars, currentPrice)` 纯函数 + `getChipDistribution(code, days=95)` DB取数（多取5根算peakDrift偏移窗口）。
- 算法：120价格桶，逐日旧筹码×(1−换手率)衰减+当日新筹码三角分布(峰在close)撒入；totalShares归一化掉（shape scale-invariant）。缺换手率降级固定衰减γ=0.97。
- 派生4子维度：concentration90 / profitRatio / peakPos / peakDrift。导出 `describeChipShape`/`formatChipSummary`。
- **避免双实现**：services/ai-screen/indicators.ts 的 `chipFeatures` 仅薄封装调 lib/chip.ts（参考 [[project-architecture]] 双指标源前车之鉴）。
- 客户端取数走 `app/api/chip/route.ts`（GET ?code=）+ `services/stockApi.ts` 的 `getChipData()`（客户端不能直接 import lib/chip 的 prisma）。

## AI 筛选 chip 因子（Phase 2，第8因子，低权重0.02-0.06）
- candidates.ts `array_agg(d.turnover_rate)` 拉换手率序列；序列窗口 90→100 日历日（多5根供drift）。
- 4子维度横截面 rankScore 合成（集中度0.3/获利盘0.3/峰位0.25/漂移0.15），暧昧性靠排名吸收不设绝对阈值。
- 4预设 factorWeights 各加 chip（balanced 0.06/momentum 0.04/quality 0.02/defensive 0.04）并下调其他因子使和=1，rulesText 同步。
- **陷阱**：scorer L229 `weights[key]??0`，4预设必须全补权重否则静默置零；engine.dbPickToAiPick 必须加 chip 字段否则补救重排丢字段。
- risk.ts 加 chip_high_trap 风险点（获利盘<0.35+主峰上方）；prompt.ts candidateFull 加筹码行供LLM解读。

## R18/R19 弱提醒预警（Phase 3，B级参考，不计入共振硬聚合）
- R18 筹码低位密集（买）：concentration90<0.18 AND profitRatio>0.6 AND 主峰≤现价×1.03
- R19 筹码高位套牢（卖）：profitRatio<0.4 AND 主峰>现价×1.05 AND ret20d>15%
- checkAllRules 扩可选第4参 `chip?`；新增 `REFERENCE_RULE_IDS=Set(['R18','R19'])`，app/page.tsx 共振聚合剔除但保留展示。
- R19 入 SELL_RULE_IDS；3调用方传 chip：app/page.tsx checkAlerts、app/ai/page.tsx(心姐+深度两路径)、app/stock/[code]/page.tsx loadData。
- deepAnalysisPrompt.ts RULES_TABLE 加 R18/R19，"12条"改"14条"。

## AI 分析/对话注入（Phase 4）
- app/ai/page.tsx 深度分析：chipNote 注入 stage1 userPrompt，让 LLM 解读暧昧形态（不硬编码结论）。
- lib/chat-tools.ts 加 `get_chip_distribution` 工具（executeTool 内 `await import('@/lib/chip')`）。

## 待办/注意
- 回补前 turnover_rate 全 NULL → 降级固定衰减近似（峰形/获利盘/集中度仍可用，仅无转移模型归一化语义），R18/R19阈值仍可触发。
- 设计哲学：暧昧形态不靠硬阈值——筛选靠横截面排名、分析靠LLM解读、预警靠宽松阈值弱参考，三处都不做一票否决/通过（用户明确要求低权重提醒）。
- 未做个股详情页筹码分布图（用户未选），保留为后续可选。
