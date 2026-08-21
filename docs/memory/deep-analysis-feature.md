---
name: deep-analysis-feature
description: "深度分析——2026-08-07并行化重做(波1四并发+R2串行链+manager并入裁决+逐字直播+断网续跑)；2026-08-10数据新鲜度大修(指数实时化/T-1全标注/moneyflow字段错位修复)；编排改动需engine.ts/route.ts两镜像同步，prompt数据内容只在engine.ts"
metadata: 
  node_type: memory
  type: project
  originSessionId: ef2354ff-72dd-4ca6-8a4d-cb53d34a3882
  modified: 2026-08-10T08:09:39.166Z
---

2026-07-31 深度分析三轮重做；**2026-08-07 并行化+流式重做**（用户反馈"一次几分钟、网络波动就停"）。对外文案「深度分析」，合规禁"股"字(见 [[naming-compliance]])。与 [[tscore-feature]] 互斥运行。

## 2026-08-07 并行化+流式重做（当前架构）

**编排（9次串行 → 5次等待）**：
- 波1 **4 并发**：analyst + tech/risk/xinjie R1。R1 三人只读同一份 debateData（`split('以下是一份深度分析师报告')[0]` 切掉分析师报告），串行时代码也是各读各的 → 并发零信息损失。用户拍板：R2 必须保留链式（"下一个人要拿到上一个人的反驳"）
- R2 **串行反驳链**：tech_r2(看r1+x1) → risk_r2(看t1+x1+techR2) → xinjie_r2(看t1+r1+R2摘要) — 未动
- **manager 已删除并入裁决**：裁决 prompt 要求先输出【综合评判】(对比三人论点+5级情绪强度+是否改变初判，吸收原「辩论对我的影响」段) 再写字段。manager 当年只看每人 200 字碎片，信息价值低。`buildManagerPrompt` 已删
- 裁决输出格式：【综合评判】→ 9个KEY字段(新增 KEY_POINTS 正式入 prompt) → `---` → 决策理由/操作计划/风险提示 3 段
- `Promise.allSettled` 波内失败等全部落定再抛（成功阶段已写断点，续跑不浪费）

**正文逐字直播**（此前直连路径只直播 reasoning，正文攒到阶段结束整段蹦出）：
- 直连 [engine.ts](services/deep-analysis/engine.ts) runStage onDelta：analyst/verdict 正文直接追加 emit（verdict 每 delta 渐进 parseVerdictContent，卡片逐字段亮起）；辩论角色 per-role buffer，按 `DEBATE_R1_KEYS/DEBATE_R2_KEYS` 固定顺序 composeDebate()（并发不串味）
- **重试回滚**：runStage 重试前 rollbackLive 把本轮已直播内容裁掉，防重复段落
- 服务器中转：route 完成消息带 `full: 全量文本` 权威覆盖（防重试/丢包增量不一致）；回放也走 full。客户端按 role 缓冲拼装
- 阶段指示**单调推进**（stageRank idle<analyst<debate<verdict，只升不降），DeepResult 加 `analystDone/debateDone` 供卡片游标/ReasoningPanel isStreaming 判断（并行后不能再靠 stage）

**断网自动续跑**（page.tsx runDeepAnalysis）：非 AbortError 失败且断点有进度 → toast「网络波动，正在自动续跑」→ 2.5s/5s 退避自动重试 ≤2 次（复用同一 ctx，不重新备数据）。completedMap 现在**直连/中转共享同一对象**（runDeepAnalysisViaServer(opts, completedMap)），降级/失败断点都最新。旧断点含 manager 键无害（不再读）。

**裁决韧性（2026-08-07 用户拍板"最坏也有裁决"，核心产出必须输出）**：
- **上游宽容**：波1/R2 全部改 safeRun/safeRunOrReplay，失败角色记入 degraded 返回空串，不再"任一失败即终止整次分析"。分析总继续到裁决
- **裁决三档降级**：完整(analyst+debate+校准) → 去辩论+去校准(输入大幅减小) → 极简(仅基础数据)。每档失败清空已直播残片再试；档间跳过无意义重复(该档无更少内容)。route 降级前发 `{stage:'verdict', reset:true}` 让客户端清缓冲（协议字段）
- **规则兜底 buildFallbackVerdict**：三档 LLM 全败 → 纯规则合成（零 LLM 依赖）：方向取 engineSummary 信号正负(/卖出|清仓|破位|死叉/ 等正则)，价位/仓位取 levels 候选区间中值×regime 系数，置信度压到 45，格式与 LLM verdict 完全一致(可被 parseVerdictContent 解析→落库/展示复用)。verdictError 带最后失败原因（用户 key 坏了能看出来）
- **warnings 透传**：DeepResult.warnings（上游失败角色/verdict_attemptN/fallback_rule），UI 裁决卡片顶部琥珀提示"部分内容生成失败已跳过"。DeepContext 加 engineSummary 字段(兜底依据)
- 直连/中转兜底各一份：direct 在 engine 内就地兜底；viaServer 收 route 的 error 后 catch 内兜底（有 ctx 就能兜）
- **残缺分析就地标注 + 不落库**（用户 08-07 追加）：warnings 逐阶段就地标注——分析师失败→情报卡片红块"生成失败已跳过"；辩论部分失败→辩论卡片列失败角色；裁决 fallback_rule→红色"规则引擎兜底结果"。warnings 代码段名在 page.tsx WARN_LABELS 映射成中文(tech→技术分析师等)。**warnings 非空(任一阶段失败)=残缺，page.tsx 跳过 saveDeepEval 不落库**(防污染胜率复盘)；addHistory 保留但加"[内容不完整]"前缀；完成时 toast.warning
- 代价：直连→服务器降级熔断基本闲置（宽容后 direct 几乎不 throw 除 AbortError）；LLM 全挂时用户拿到规则兜底而非错误+继续按钮——这是用户明确要的取舍

**AI 对话全流式**（此前工具轮非流式，不调工具时整段蹦出）：`readLlmDeltasWithTools`（[lib/llm-stream.ts](lib/llm-stream.ts)）按 index 累积 tool_calls 分片；[browser-chat.ts](services/chat/browser-chat.ts) 与服务器 chat route 全部轮次 stream:true，正文直播、工具分片静默。注意 interface 里 `function` 是保留字要加引号（TS1359）。

**ReasoningPanel 窥视模式**（components/ai/ReasoningPanel.tsx）：默认固定 ~3 行高度 + 自动滚底（看到思考在滚动）+ 顶部渐隐；点标题展开全文；≤120字直接全显。

## 2026-08-10 数据新鲜度大修（"今日普涨"误报根因修复）

**根因**：tushare 日线族接口（daily/daily_basic/index_daily/index_dailybasic/margin_detail）盘中无当日行（官方 15~16 点批量入库），`stock-data` 路由用 `dailyBasic[0].trade_date` 当基准日 → 盘中恒 T-1；而「大盘环境」块是全 prompt 唯一不带日期的数据块 → LLM 把周五指数涨幅写成"今日普涨"。

**修复（①②③+④）**：
- ① 六指数实时化：`getMarketIndexQuotes()`（stockApi.ts，MARKET_INDICES 白名单）走 `/api/quote` 个股同通道——腾讯/新浪 parser 对指数字段布局**天然兼容**（实测）。三 parser 透传行情自带时间戳（腾讯[30]=YYYYMMDDHHmmss、新浪[30][31]、东财f86 unix秒）→ buildQuoteResponse 加 updateTime 参数，非交易日能识别"非今日"。`formatTushareForPrompt(data, indexQuotes)` 两层渲染：「今日大盘（实时，截至HH:MM）」+「大盘估值（MM-DD收盘，tushare）」；实时缺层→降级「大盘环境（MM-DD收盘数据，非当日实时）」
- ② T-1 标注三件套：levels.ts rationale 市场状态带 `breadthDate`、rpsNote 带 `calcDate`（StockRpsResp 类型已加）、chipNote 带 `asOfDate`（lib/chip.ts ChipDistribution 新字段，DbBar SELECT 加 tradeDate）
- ③ 盘中背离提示：regime=T-1宽度判定 vs 今日六指数均值，strong且均值≤-1% 或 weak且≥+1% 时生成 regimeConflictNote 进 marketStatusNote（波1/辩论）+ levelsText（裁决）。**只提示不改 regimeFactor 数值**（仓位公式未回测）
- ④ moneyflow 字段错位修复：THS 迁移后 route 返回 prisma camelCase（netAmount/netD5Amount/buyLgRate…），formatter 还读旧东财 snake_case → 30行全"持平0万"→LLM误判"资金数据缺失"。MoneyflowItem 已改 THS 结构，区块改 5 日逐行+netD5Amount 汇总
- prompt 防呆：deepAnalysisPrompt 市场环境指令加"非当日数据禁止写成今日"
- **AiChat（AI对话）不含指数块、不用 formatTushareForPrompt**，不受影响；t-score prompt 同样无指数块

** freshness 全景（盘中）**：实时=quote/K线（buildUpdatedKLines合成今日bar)/指标/价格类规则/开闭市状态；T-1=tushare全家/RPS(rps_scores)/宽度(market_breadth)/筹码(daily_bars)/资金流(stock_moneyflow_ths)——后四者都是 run-daily 晚间脚本链产物。本地开发无 DATABASE_URL（lib/db.ts 回退 localhost），查生产库须上服务器。

## 文件结构(下次改这几处)
- `services/deepAnalysisPrompt.ts` — 全部 prompt builder。**无 manager**。verdict = buildVerdictSystemPrompt（含【综合评判】要求）
- `services/deep-analysis/levels.ts` — 数字分工核心，computeKeyLevels 候选价位，改系数改这里
- `services/deep-analysis/engine.ts` — 直连编排主路径（波1并发+R2链+裁决）+ 服务器中转客户端解析 + parseVerdictContent（consensus 字段）+ buildDeepSummary（优先 structured.consensus，旧记录兜底正则辩论文本）+ 断点持久化
- `app/api/ai/deep-analyze/route.ts` — 服务器中转镜像（同一波结构，改动必须两边同步）
- `app/ai/page.tsx` — runDeepAnalysis（自动续跑循环）+ 综合评判卡片段
- 历史/回测：deep-eval route、stats route、backfill 脚本未动

## 大坑(历史教训)
- **route 切分依赖标记**：辩论数据靠 `split('以下是一份深度分析师报告')`、verdict 靠 `split('## 分析师报告')`。注入内容必须拼在对应标记**之前**
- deep_analysis_records 曾因缺 @map 从未入库（07-31~08-03 0 条）；改 schema 必须服务器 `npx prisma generate` 再 restart
- finaIndicator 字段级清洗在 tushareData.ts sanitizeTushareData：异常字段剔除不丢整段；finaIndicator 阈值 1e13（大盘金融类绝对值正常），其他 1e11——基本面莫名缺失先查这里
- 旧断点/旧浏览器缓存与新 SSE 协议（full 消息）不兼容场景自恢复，无需迁移

## 数据流（未变部分）
prepareDeepContext：并行拉 quote/kLines/tushare/rps/breadth → marketRegime → checkAllRules+chip+indicators → computeKeyLevels → 三阶段 prompt。stage3 verdict 由 route/engine 拼 `## 分析师报告`/`## 多空辩论`（buildVerdictUserPrompt 的 stage1/2 参数为空串占位）。

## 待办
- 回测数据积累后(≥20交易日+几十条record)：confidence 分桶胜率、目标价命中率、仓位档位有效性
- prompt A/B：综合评判并入后观察裁决质量（格式失败率、clamped 频次）
- 并行化后观察中转站 429（波1 4 并发打到用户自己的 key/中转）
- C 强确认档门槛(≥2条共振)观察后调
