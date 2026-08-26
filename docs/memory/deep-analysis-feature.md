---
name: deep-analysis-feature
description: 深度分析当前架构——波1四并发+R2串行链+manager并入裁决；裁决三档降级与规则兜底（但致命 API 错误 08-21 起不兜底直接冒泡）；数据新鲜度口径与 freshness 全景
metadata:
  node_type: memory
  type: project
  modified: 2026-08-24T02:15:00.000Z
---

深度分析。对外文案「深度分析」，禁"股"字（[[naming-compliance]]）。与 [[tscore-feature]] 互斥运行。

> 2026-07-31 三轮重做 → 08-07 并行化+流式重做 → 08-10 数据新鲜度大修 → 08-21 致命错误不兜底。本文只写当前形态，过程考古走 git log。

## 编排（当前）

- **波 1 四并发**：analyst + tech/risk/xinjie R1。R1 三人只读同一份 debateData（`split('以下是一份深度分析师报告')[0]` 切掉分析师报告），串行时代码也是各读各的 → 并发零信息损失。
- **R2 串行反驳链**（用户拍板必须保留链式，"下一个人要拿到上一个人的反驳"）：tech_r2(看 r1+x1) → risk_r2(看 t1+x1+techR2) → xinjie_r2(看 t1+r1+R2摘要)。
- **manager 已删除并入裁决**：裁决 prompt 要求先输出【综合评判】（对比三人论点 + 5 级情绪强度 + 是否改变初判）再写字段。`buildManagerPrompt` 已删。
- 裁决输出格式：【综合评判】→ 9 个 KEY 字段 → `---` → 决策理由/操作计划/风险提示 3 段。
- 心姐辩手（`buildXinJieR1/R2`）保留在 deepAnalysisPrompt.ts；`services/xinjiePrompt.ts` 已删。

## 韧性（分两层，别混）

**① 非致命失败 = 宽容 + 降级**
- 波1/R2 角色走 `safeRun/safeRunOrReplay`：失败记入 degraded 返回空串，**不再"任一失败即终止整次分析"**，分析总继续到裁决。
- **裁决三档降级**：完整（analyst+debate+校准）→ 去辩论去校准 → 极简（仅基础数据）。每档失败先清空已直播残片再试；档间跳过无意义重复。route 降级前发 `{stage:'verdict', reset:true}` 让客户端清缓冲。
- **规则兜底 `buildFallbackVerdict`**（engine.ts:307）：三档 LLM 全败 → 纯规则合成，零 LLM 依赖。方向取 engineSummary 信号正负（`/卖出|清仓|破位|死叉/` 等正则），价位/仓位取 levels 候选区间中值×regime 系数，置信度压到 45，格式与 LLM verdict 一致（可被 `parseVerdictContent` 解析 → 落库/展示复用）。
- **warnings 透传**：`DeepResult.warnings`（失败角色 / verdict_attemptN / fallback_rule）→ UI 裁决卡片顶部琥珀提示；`WARN_LABELS` 映射中文。
- **残缺分析就地标注 + 不落库**：warnings 非空 = 残缺 → page.tsx 跳过 `saveDeepEval`（防污染胜率复盘）；addHistory 保留但加"[内容不完整]"前缀 + toast.warning。

**② 致命 API 配置错误 = fail-hard（2026-08-21 新增，别再"顺手加兜底"）**
- `FatalApiError` / `isFatalApiStatus`（`lib/ai-error.ts`）：**401/403/404/402 不重试、不降级、不兜底，直接冒泡**——key 失效/过期/模型不存在时用户必须看到真错误，而不是拿到一份规则兜底还以为分析成功。
- 波内改回 `Promise.all`（不再 `allSettled` 吞致命错误）；`safeRun` 只吞非致命失败；route 侧 `msg.fatal` 客户端也直接 throw 不兜底。

## 流式与续跑

- **正文逐字直播**：runStage `onDelta` — analyst/verdict 正文直接追加 emit（verdict 每 delta 渐进 `parseVerdictContent`，卡片逐字段亮起）；辩论角色 per-role buffer 按 `DEBATE_R1_KEYS/R2_KEYS` 固定顺序 `composeDebate()`（并发不串味）。**重试前 `rollbackLive` 裁掉本轮已直播内容**，防重复段落。
- 服务器中转：route 完成消息带 `full: 全量文本` 权威覆盖（防重试/丢包增量不一致），回放也走 full。
- 阶段指示**单调推进**（stageRank idle<analyst<debate<verdict 只升不降）；`analystDone/debateDone` 供卡片游标与 ReasoningPanel `isStreaming` 判断（并行后不能再靠 stage）。
- **断网自动续跑**（page.tsx `runDeepAnalysis`）：非 AbortError 且断点有进度 → toast「网络波动，正在自动续跑」→ 2.5s/5s 退避重试 ≤2 次（复用同一 ctx 不重新备数据）。`completedMap` 直连/中转共享同一对象。
- AI 对话全流式：`readLlmDeltasWithTools`（lib/llm-stream.ts）按 index 累积 tool_calls 分片，全部轮次 `stream:true`。注意 interface 里 `function` 是保留字要加引号（TS1359）。
- ReasoningPanel 窥视模式：默认 ~3 行高 + 自动滚底 + 顶部渐隐，点标题展开全文，≤120 字直接全显。

## 数据新鲜度（2026-08-10 大修，"今日普涨"误报根因）

**根因**：tushare 日线族（daily/daily_basic/index_daily/index_dailybasic/margin_detail）盘中无当日行（官方 15~16 点入库），路由拿 `dailyBasic[0].trade_date` 当基准日 → 盘中恒 T-1；而「大盘环境」是全 prompt 唯一不带日期的块 → LLM 把周五指数涨幅写成"今日普涨"。

- **六指数实时化**：`getMarketIndexQuotes()`（stockApi.ts，MARKET_INDICES 白名单）走 `/api/quote` 同通道——腾讯/新浪 parser 对指数字段布局天然兼容（实测）。三 parser 透传行情自带时间戳（腾讯[30]、新浪[30][31]、东财 f86 unix 秒）→ `buildQuoteResponse` 加 updateTime，非交易日能识别"非今日"。`formatTushareForPrompt(data, indexQuotes)` 两层渲染：「今日大盘（实时，截至 HH:MM）」+「大盘估值（MM-DD 收盘，tushare）」；实时缺层 → 降级「大盘环境（MM-DD 收盘数据，非当日实时）」
- **T-1 标注三件套**：levels.ts rationale 带 `breadthDate`、rpsNote 带 `calcDate`、chipNote 带 `asOfDate`
- **盘中背离提示**：regime（T-1 宽度）vs 今日六指数均值，strong 且均值 ≤−1% 或 weak 且 ≥+1% → `regimeConflictNote` 进 marketStatusNote（波1/辩论）+ levelsText（裁决）。**只提示不改 regimeFactor 数值**（仓位公式未回测）
- **moneyflow 字段错位修复**：THS 迁移后 route 返回 prisma camelCase（netAmount/netD5Amount/buyLgRate…），formatter 还读旧东财 snake_case → 30 行全"持平 0 万"→ LLM 误判"资金数据缺失"。`MoneyflowItem` 已改 THS 结构，区块改 5 日逐行 + netD5Amount 汇总
- prompt 防呆：市场环境指令加"非当日数据禁止写成今日"
- **freshness 全景（盘中）**：实时 = quote / K线（`buildUpdatedKLines` 合成今日 bar）/ 指标 / 价格类规则 / 开闭市状态；**T-1 = tushare 全家 / RPS(rps_scores) / 宽度(market_breadth) / 筹码(daily_bars) / 资金流(stock_moneyflow_ths)**——后四者都是 run-daily 晚间脚本链产物。
- AiChat（AI 对话）不含指数块、不用 `formatTushareForPrompt`，不受影响；t-score prompt 同样无指数块。

## 文件结构（下次改这几处）

- `services/deepAnalysisPrompt.ts` — 全部 prompt builder。**无 manager**。verdict = `buildVerdictSystemPrompt`（含【综合评判】要求）
- `services/deep-analysis/levels.ts` — 数字分工核心，`computeKeyLevels` 候选价位，改系数改这里
- `services/deep-analysis/engine.ts` — 直连编排主路径 + 中转客户端解析 + `parseVerdictContent` + `buildDeepSummary` + 断点持久化 + `buildFallbackVerdict`
- `app/api/ai/deep-analyze/route.ts` — 服务器中转镜像（同一波结构，**改动必须两边同步**）
- `app/ai/page.tsx` — `runDeepAnalysis`（自动续跑循环）+ 综合评判卡片段
- ⚠️ **prompt 的数据内容只在 engine.ts 改**；编排改动 engine.ts 与 route.ts 两镜像同步

## 大坑（历史教训）

- **route 切分依赖标记**：辩论数据靠 `split('以下是一份深度分析师报告')`、verdict 靠 `split('## 分析师报告')`。**注入内容必须拼在对应标记之前**
- `deep_analysis_records` 曾因缺 `@map` 从未入库（07-31~08-03 零条）；改 schema 必须服务器 `npx prisma generate` 再 restart（[[server-info]]）
- finaIndicator 字段级清洗在 `tushareData.ts sanitizeTushareData`：异常字段剔除不丢整段；阈值 finaIndicator 1e13（大盘金融类绝对值正常）其他 1e11——**基本面莫名缺失先查这里**
- `deep_analysis_records.action` 曾有脏值（`** 持有`/`（买入）`），engine.ts `normalizeAction()` 已根治
- 本地开发无 DATABASE_URL（lib/db.ts 回退 localhost），查生产库须上服务器

## 数据流（未变）

`prepareDeepContext`：并行拉 quote/kLines/tushare/rps/breadth → marketRegime → `checkAllRules`+chip+indicators → `computeKeyLevels` → 三阶段 prompt。stage3 verdict 由 route/engine 拼 `## 分析师报告`/`## 多空辩论`（`buildVerdictUserPrompt` 的 stage1/2 参数为空串占位）。

## 待办

- 回测数据积累后（≥20 交易日 + 几十条 record）：confidence 分桶胜率、目标价命中率、仓位档位有效性
- prompt A/B：综合评判并入后观察裁决质量（格式失败率、clamped 频次）
- 并行化后观察中转 429（波1 四并发打到用户自己的 key）
- C 强确认档门槛（≥2 条共振）观察后调
