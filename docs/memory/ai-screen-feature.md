---
name: ai-screen-feature
description: AI 筛选当前状态——管线/四预设权重/门槛/LLM 分片重排参数（均已对代码复核）+ 已被十年回放推翻的结论 + 未解决的池构建问题
metadata:
  node_type: memory
  type: project
  modified: 2026-08-24T02:10:00.000Z
---

「AI 筛选」已部署（2026-07-29 胜率优先重构）。对外一律称「筛选」，禁"选股/荐股/股票"字眼（[[naming-compliance]]）。入口：AI 分析页 `/ai` 内模式切换；胜率复盘在首页「复盘」弹窗（[[frontend-state-conventions]]）。

> 本文只写**当前状态**与**已被推翻的结论**。各轮实验过程（08-03/07/11/14/15/19/21）已移除——后一轮常覆盖前一轮，堆在一起会误导。考古走 `git log -p docs/memory/ai-screen-feature.md`。

## 管线

L1 候选池 SQL（`candidates.ts`：array_agg 近 60 根 OHLCV + 基本面 + 行业，按 RPS 倒序 LIMIT 200）→ enrich（`enrichWithReason`，引擎与审计脚本共用同一逻辑）→ 因子打分（`scorer.ts`）→ LLM 重排（`ranker.ts`，可选）→ 风险层（`risk.ts`，读 pick 字段与因子解耦）→ 门槛过滤 → 截取 `maxOutput`

- **全候选落库**：`AiScreenPick.selected/rank`（消除幸存者偏差，是 IC / A-B 的前提）；`rescueRun` 补救路径先 updateMany 清 selected/rank 再重标 top-N
- **多用户共享**：`@@unique([strategyId, barDate])`，首跑花 token 后续秒取；v4 门控仅 DeepSeek v4 落库
- **首跑并发去重**：`firstRunInflight Map<strategyId_barDate, Promise>`；客户端网络异常 3 次退避重试（3s/6s，330s 超时），`data.error` 不重试

## 因子与权重（事实源 `services/ai-screen/strategies.ts`）

| preset | entry_timing | quality | risk | box | cross13 | trend | liquidity | theme_heat | chip |
|---|---|---|---|---|---|---|---|---|---|
| balanced | 0.35 | 0.30 | 0.25 | 0.05 | 0.05 | 0 | 0 | 0 | 0 |
| momentum | 0.30 | 0.25 | **0.35** | 0.05 | 0.05 | 0 | 0 | 0 | 0 |
| quality | 0.32 | 0.34 | 0.22 | — | — | 0.05 | 0.03 | 0.02 | 0.02 |
| defensive | 0.28 | 0.22 | 0.32 | — | — | 0.05 | 0.06 | 0.03 | 0.04 |

⚠️ **box / cross13 只配在 balanced/momentum**；scorer 取权重是 `weights[key] ?? 0`，**新增因子必须四个 preset 都补**，否则静默置零（踩过）。

因子语义（改这些改 `scorer.ts`）：
- **entry_timing = 池内横截面排名**（`rankScore`，最好 100 / 最差 0 / NA 中性 50）。绝对分在 RPS≥70 动量池里被压扁（多数 ∈[5,25]），排名化是单调变换 → Spearman IC 不变（十年"唯一强正"结论保留），但 screenScore 回归市场中性；"质量地板"改由 quality/risk 等绝对因子托底。
- **risk 只剩 vol + ATR**（回撤罚项已删，见下）
- **box** = 二元 `inBox ? 100 : 0`，事实源 `lib/box.ts` + `stock_box` 表（`compute-box.ts` 挂 run-daily，fatal:false；`--init` 60 日 / `--backfill=N`）
- **cross13** = 二元（`indicators.maCross13`：近 5 根 MA5 上穿 MA13 + 今日量 > 前 5 日均量×1.2，窗口比 alertRules R04 略宽）
- **signalScore 不喂任何因子**（含 MA/MACD/RSI 复合会泄漏），只供 `risk.ts` 读

## 门槛与入选数

- `DEFAULT_MIN_SCREEN_SCORE = 50`（未显式配置的旧预设 quality/defensive 回退到此）
- **balanced / momentum：`minScreenScore = 40`，`maxOutput = 30`**
- 不满 N 就少选；`[runId]` 展示层按 `run.strategyId` 取同一门槛；前端空态区分「无 run」vs「有 run 但 0 入选」

## LLM 重排（`ranker.ts`）

- `RANK_WEIGHT = 0.4`，`final = screen×0.6 + llm×0.4`；覆盖率 ≥0.6 门控 + 1 次重试
- **`SHARD_SIZE = 10` 分片并行 + `reasoning_effort:'low'` 是唯一 100% 可靠组合**（08-11 三轮实验：思考长度不随候选数缩减，50 一次喂 0/2 成功）
- `LLM_MAX_TOKENS = 12288`；中转卡 max_tokens 会 400 → **自动降级 4096 且去掉 `reasoning_effort` 重试一次**
- **只送 `screenScore ≥ 门槛` 的候选**（过滤提前到输入侧）：弱市省 70%+ token，坏市全灭时跳过 LLM 不调，入选结果不变
- `callLlm` 返回 `{content, reasoning}` 分开读：content 优先做 JSON 源，reasoning 只作最后兜底并标 `reasoning_content_fallback`
- 片间标尺三锚并存：静态分数带（`buildShardPoolContext`）+ 全池 identity 行 + 已有分的 alreadyScored 参照

## 回路与观测

- **T+N**：`AiScreenEval`（nDays 1/5/20）+ `scripts/backfill-ai-screen-eval.ts`（交易日序列取自 daily_bars distinct tradeDate，不依赖 tushare），挂 run-daily（fatal:false，失败不阻断日任务）
- **胜率复盘**：`/api/ai-screen/stats` + `components/ai/AiScreenStats.tsx`——因子 IC（Spearman 自建）+ 5 分位胜率、策略排行（performance_score）、LLM A/B（纯 screen / 0.6·0.4 融合 / screen 否决 llmRisks，从已存分数反算无需重跑）、事件信号复盘。主口径 T+5，也展示 T+1/T+20
- **regime 标记**：`services/ai-screen/regime.ts`（market_breadth MA55 上方占比 + rps_scores ret_20 全市场中位数 → attack/neutral/defense）。**只标记不拦截**（run.marketRegime 落库 + 徽章 + defense 时加 degradation）；阈值 0.35/0.55/−4% 是拍的**未验证**。同文件 `tradingDayLag`：barDate 滞后 ≥2 → `stale_bars_lagN`（法定节假日未剔除，长假后可能误报，仅标记无害）
- **漏斗审计**：`scripts/audit-ai-screen-funnel.ts`（L1 池 → L2 主因分布 → L3 打分分布 → L4 风险层 → L5 topN + 瓶颈诊断）
- **展示层过滤**：`[runId]` 的 sector/level/board 参数在全候选池按 sw_index_member + ts_code 前缀过滤后按 screenScore 重切 top-N（不动 L1、不另起策略）

## 已被推翻的结论（别重蹈）

依据 = 十年全市场回放（20161208~20260717，2332 交易日，IS1632/OOS700）+ 扫描条件归因回放（`backtest-scan-phases.ts`）：

- **trend / liquidity / theme_heat 清零**：OOS −0.056~−0.065；log 成交额全市场 IC −0.083（t=−29，全场最强）跨牛熊稳定反向
- **均线多头排列是反指**（RPS≥87 池 3~20 日全程负，越久越差）→ 上升期预设去多头；momentum 的 `requireMaBullish` 硬筛已删，`trend()` 内 maBullish 加减分同步移除
- **risk 回撤罚项已删**：dd20 IC 两窗口稳定正 +0.045/+0.050（深回撤 = 超跌反弹，罚它是反的）。也**没有**加成正项（与 entry_timing 回踩相关，防双计）
- **箱体是全场最强条件**（+3.3pp，T+20 胜率 50.6%）→ 升二元因子，并进全市场扫描器（无 RPS 前置才是正宗用法：`/api/scan` 的 `box=in|breakout`）
- 乖离默认 **30→20**（+0.8 vs +0.5pp）
- **"弱市门控"被数据部分推翻**：纯 RPS 池防守期最好（T+20 +0.65%）进攻期最差，但趋势型预设防守期 T+20 −2.4%/−1.2% → 不做 blanket 门控，改**分策略警告**（`/api/market/regime` + 扫描页防守期且勾趋势条件时一句 amber 提示）
- **"LLM 遗珠捞 31-50"已作废**：被门槛覆盖——规则分 < 门槛的候选即使 LLM 拉高也不入选
- **组合分散约束（同板块最多 2 只）已删**：`portfolioProfile` + `applyPortfolioOverlay` 死代码 08-21 清完；DB `portfolio_penalty` 列保留，想恢复只需加回 preset 字段
- **chip 符号不稳 → 权重 0**；quality 有未来函数但人工保留

## ⚠️ 未解决的大项（待立项）

- **候选池十年全周期跑输市场**：池超额 balanced −0.22% / momentum −0.27%（T+5 日均），而 680 天窗口为正 → 动量池是牛市产物。**评分器池内有效**（Top20 捞回 −0.05%），拖后腿的是**池构建**。方向 = 弱市门控接上 regime 的拦截角色。
- **balanced 权重失真复验**：entry_timing 曾 50% 压在动量池，分数塌在 35-40。08-21 横截面化 + 权重再平衡是一阶修正，需**撞一次真正 defense 期**后回测复验，不是门槛能修的。

## 待办（数据依赖，别提前做）

- 因子权重按 IC 迭代（看复盘面板因子 IC 表 + 5 分位胜率）；**box / cross13 待 IC 验证**
- `RANK_WEIGHT=0.4` 去留：看 LLM A/B 三组胜率；噪声嫌大可双跑取均分（未做）
- 事件信号 apply：preferred/avoided_event_tags 现只展示，每信号样本 ≥5-10 后再人工进 `rankingHints`
- stats API 重量级查询：现 `take:30000` + include evals，候选池到 4策略×200×90天 ≈ 7 万条会截断且慢，届时改 DB 侧聚合或分页
- L3 候选上下文（新闻/公告/资金流喂 LLM）：最能治"粗糙"但最贵，等 IC 验证因子有效性后再考虑
- 策略 DB 化编辑器：仍硬编码 `strategies.ts`，等权重需频繁调时再做

## 坑

- **json_parse_failed 历史根因**：思考型模型（deepseek-v4-flash）先吐 reasoning_content，候选越多思考越长 → 烧光 max_tokens → content 空/只剩前奏残片。分片化后基本消失；再遇到查 PM2 日志 `[ai-screen/ranker] json_parse_failed` 那行打印的原始输出前 300 字
- 部署迁移一律 raw SQL（`migrate-ai-screen-eval.sql` / `migrate-ai-screen-regime.sql` / `migrate-stock-box.sql`），**勿跑 `prisma db push`**（见 [[server-info]]）
- scanner 的 board 正则 `^(600|...)\.` 对 `"600000.SH"` 其实匹配不上（**既有 bug 未修**）；ai-screen `[runId]` 用的是正确的 `matchBoard`
- 列名陷阱见 [[project-architecture]] DB 节；T+N 回填用 Prisma client 规避
- `breakout20dPct` 取前 19 根最高（off-by-one，排除当日），shape_status 阈值影响极小
- `[runId]` 板块过滤后 `run.pickCount/candidateCount` 仍是全局数，前端"候选 X 入选 Y"不随过滤变
- `ranker.ts` 里 TOPK=50 的注释还写着"maxOutput=20"（08-21 已回改 30），注释过期不影响逻辑
- 服务器 baseUrl 是 DeepSeek 官方（支持 `reasoning_effort`）；`chat_template_kwargs.thinking=false` 实测**无效**
