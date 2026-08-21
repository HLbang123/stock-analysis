---
name: ai-screen-feature
description: AI 筛选功能状态——胜率优先重构(7因子去泄漏+全候选落库+完整T+N回路+胜率复盘仪表盘+板块过滤)
metadata:
  node_type: memory
  type: project
  originSessionId: b5a7c91b-3c63-48e8-a949-d78e402557c0
  modified: 2026-08-19T06:16:04.124Z
---

「AI 筛选」已部署并在 2026-07-29 做了**胜率优先重构**。对外文案一律称「筛选」,禁用选股/荐股/股票字眼(见 [[naming-compliance]])。

**入口**：AI 分析页(`/ai`)内模式切换（2026-08-07 起 AiScreenPanel 只留筛选，顶部「筛选/胜率复盘」视图切换已移除；胜率复盘收拢到首页「复盘」弹窗 ReviewModal，见 [[review-modal-consolidation]]）。

## 胜率优先重构(2026-07-29)
north star = T+5 绝对收益>0 胜率。决策:激进按论点重组因子 + 纯加权求和(权重由IC调)。

**因子 8→7,信号不相交**(services/ai-screen/scorer.ts):
- trend(合并旧momentum+activity):ret60d/maBullish/macdStatus/volumeRatio/latestChange
- entry_timing(旧reversal改名):rsiStatus/pullbackToMa20Pct/latestChange
- risk(旧stability瘦身,只留vol/dd/atr,不再碰change/volume/signal)
- quality / liquidity / theme_heat / chip 不变
- **signalScore 不再喂任何因子**(它含MA/MACD/RSI复合会泄漏),仅供 risk.ts 风险层读
- normalizeWeights 兜底补全7因子(旧版缺reversal/theme_heat/chip)
- 4 preset 新权重见 strategies.ts;scoringProfile 键名改 trend_*/risk_*/entry_timing_*

**全候选池落库**(消除幸存者偏差,IC/A/B前提):
- AiScreenPick 加 `selected Boolean`+`rank Int?`可空+`maBullish/pullbackToMa20Pct/breakout20dPct`3字段
- engine.runScreen 返回 `{run, candidates(全), picks(选中top-N)}`;route 落库全候选,selected=true 标 top-N
- rescue 路径:updateMany 清空 selected/rank 再重标 top-N
- 响应只回 rank!=null 的行(兼容历史数据——旧run全员有rank)

**完整 T+N 回路**:
- 新表 `AiScreenEval`(pickId,nDays[1/5/20],exitPrice,exitDate,returnPct,shapeStatus,maxDrawdownPct,maxRunupPct);旧 exitPrice/holdingReturnPct 字段废弃保留
- 脚本 `scripts/backfill-ai-screen-eval.ts`:交易日序列取自 daily_bars distinct tradeDate(不依赖Tushare);returnPct=(exit/entry-1)*100;shape_status 移植alphasift;已接入 run-daily(fatal:false,失败不阻断日任务)
- 部署迁移 raw SQL:`scripts/migrations/migrate-ai-screen-eval.sql`(加列+建表+回填历史selected=true)。**勿跑 prisma db push**

**胜率复盘**:`app/api/ai-screen/stats/route.ts` + `components/ai/AiScreenStats.tsx`
- 因子 IC(Spearman,自建,alphasift无)+5分位胜率、策略排行榜(performance_score=50+avg*2+(win-50)*0.5-missing*20)、LLM A/B(纯screen/0.6·0.4融合/screen否决llmRisks,从已存分数反算无需重跑)、事件信号复盘(prefer/avoid/watch)
- 主口径 T+5,仪表盘也展示 T+1/T+20

**板块+主板过滤**(Part5,展示层):`[runId]/route.ts` 加 sector/level/board 查询参数,在全候选池按 sw_index_member + ts_code前缀过滤,按screenScore重切top-N。**不动L1、不另起策略**。前端 AiScreenPanel 加板块选择器(复用 /api/industries)。
- 注意:scanner 的 board 正则 `^(600|...)\.` 对 "600000.SH" 格式其实匹配不上(既有bug,未修);ai-screen 的 [runId] 用了正确的 matchBoard 函数。

## 待办(等数据多了再说,2026-07-29 起记)
数据从 2026-07-29 部署后开始累积。T+5 8 月初才有意义,IC/调权至少攒 2-3 周再动。**以下都是数据依赖型,现在做是空想:**
- **因子权重调优**:7 因子权重是初始占位,等 T+N 攒够后按 IC 迭代(IC≈0 的 chip 降权或砍)。看胜率复盘面板的因子 IC 表 + 5 分位胜率。
- **LLM 融合权重 RANK_WEIGHT(现 0.4)**:等 topK picks 的 T+5 攒够,看胜率复盘面板的 LLM A/B(纯screen/0.6·0.4融合/否决)三组胜率,决定保留/降权/改否决角色。
- **事件信号复盘 apply**:preferred/avoided_event_tags 目前只展示,等每个信号样本≥5-10 后再人工 apply 到策略 rankingHints。
- **stats API 重量级查询优化**:现 take:30000+include evals,数据少没事;候选池攒到 4策略×200×90天≈7万条时会截断且慢,届时改 DB 侧聚合或分页。
- **L3 候选上下文(新闻/公告/资金流喂LLM)**:最能治"粗糙"但最贵,等 IC 验证因子有效性后再考虑是否值得。
- **策略 DB 化编辑器**:仍硬编码 strategies.ts,等权重需要频繁调时再做。

## 非数据依赖的小优化(可随时做,低优先)
- [runId] 板块过滤后 run.pickCount/candidateCount 仍是全局数,前端"候选X入选Y"不随过滤变
- breakout20dPct 取前 19 根最高(off-by-one,n-1 排除当日),shape_status 阈值影响极小
- overlay 跑在全候选(200只)上,非选中 finalScore 被扭曲但不影响展示/IC,无害

## 部署状态(2026-07-29)
- 服务器已跑 migrate-ai-screen-eval.sql(9 条 OK):selected/3技术列/rank可空/selected索引/历史回填/ai_screen_evals表
- ranker LLM_MAX_TOKENS 已从 4096 改 8192(30只×12字段约7k token,4096会截断丢项触发覆盖率回退)
- run-daily 已接 T+N 回填(fatal:false)
- 本地无 Postgres,运行时验证在服务器做

## 2026-08-03 修复:18候选全降级纯规则(3次 json_parse_failed)
**根因**:deepseek-v4-flash 是思考型模型,先吐 reasoning_content。候选越多思考越长,8192 max_tokens 被思考烧光 → content 空/只剩前奏残片 → fefa2fe 刚加的 `content||reasoning` 兜底把思考散文喂给 JSON 解析器 → 3 次全 json_parse_failed(候选18 高质量策略复现)。测试证实 json_parse_failed 只出现在「前奏截断」和「纯思考散文」两种形态;数组中部截断会被 extractPartialItems 恢复成 low_coverage(非此错误)。
**修法**(services/ai-screen/ranker.ts,当时 0.6.0 之后的 fefa2fe 引入):
- LLM_MAX_TOKENS 8192→16384(4.5k JSON+思考余量);中转卡 max_tokens 会 400,callLlm 内自动降级 8192 重试一次(正则 `/400|max[_ -]?tokens?/`)
- callLlm 返回 `{content, reasoning}` 分开读:content 优先做 JSON 源,reasoning 仅作最后兜底(个别中转把答案放思考通道),用了就标 `reasoning_content_fallback` 降级日志
- json_parse_failed 时 `console.error` 打印原始输出前 300 字,下次再失败能定位
- 重试 prompt 文案改为「输出不是合法 JSON 或缺少候选」
**验证**:mock fetch 驱动 rankCandidates 的 tsx 脚本 15 项全过(正常JSON/思考散文/思考藏JSON/前奏截断/max_tokens400降级),tsc+eslint 干净。若再遇 json_parse_failed,查 PM2 日志里的 `[ai-screen/ranker] json_parse_failed` 那行看原始输出。

## 2026-08-07 断网容错（配合深度分析并行化那轮）
- **客户端自动重试**（AiScreenPanel run()）：fetch 网络异常/超时(330s) → toast「网络波动，正在自动重试」→ 3s/6s 退避，共 3 次尝试。POST 幂等（策略+数据日去重），重发要么挂到在途执行要么秒中缓存。`data.error`（服务器已响应）不重试
- **服务器 in-flight 去重**（api/ai-screen/route.ts）：`firstRunInflight Map<strategyId_barDate, Promise>`——并发/重试/双击的首跑请求共享同一次 runScreen 执行，不重复烧 token；在途失败则后来者自己重跑占位。首跑执行体抽成 `runFirstRun(preset, cfg)`（含质量门控落库 + P2002 兜底）
- 深度分析那轮的并行化/自动续跑细节见 [[deep-analysis-feature]]

## 2026-08-15 十年回放落地（扫描条件归因 + box 升因子 + regime 分段）
`backtest-scan-phases.ts` 扩展（regime 分段 + 箱体分桶 + box 单槽缓存），经 SSH base64 直传服务器跑完（462只×1500日，RPS覆盖99.8%）。**结论与已执行动作**：
- **箱体=全场最强条件**（+3.3pp，T+20胜率50.6%；因子分桶口径一致但质量分非线性<60桶最佳）→ scorer 升**二元因子** box（inBox?100:0），balanced/momentum 权重 0.05（entry_timing 各挪 0.05），rulesText/统计口径同步；optimize-params 与 stats route 的 FACTOR_KEYS 加 'box'
- **多头排列在 RPS≥87 池是反指**（3~20日全程负，越久越差；消融上升期−多头 +0.9pp）→ 上升期预设**去多头**（保留三线上行+距新高≤25+乖离0~20）；回踩预设不动（+1.9pp 最佳）。⚠️ 结论可能池依赖，待 --base-rps=70/0 复验后再定 UI 去留
- **乖离默认 30→20**（+0.8 vs +0.5pp）
- **regime 方向反转**：纯 RPS 池防守期最好（T+20 +0.65%）进攻期最差，但趋势型预设防守期 T+20 **-2.4%/-1.2%** → 不做 blanket 弱市门控，改分策略警告：新 `/api/market/regime` + 扫描页防守期且勾选趋势条件时一句 amber 警告。「弱市门控」立项结论被数据**部分推翻**，AI 筛选池归属待生产 regime 标记积累后精确判定
- **部署方式注意**：本轮全部经 SSH tarball 直传 + npm build + pm2 restart，**服务器代码领先 git**（含此前 backtest 脚本直传），用户晚间 commit 后拉平，内容一致无需处理
- strategies.ts 另被用户并行 session 改过（risk 删回撤罚项、权重十年复核版），已合并保留

## 2026-08-14 移除组合分散约束 + 吸筹项目三借鉴落地
用户认为「同板块最多2只」不合理，已删除：4 个 preset 的 `portfolioProfile`（strategies.ts）+ rulesText 里「组合约束」行。机制本体保留（risk.ts `applyPortfolioOverlay` 无 profile 时 early-return，DB `portfolio_penalty` 列保留）。想恢复加回 preset 字段即可。

同日落地 `_archived/accumulation-breakout-survey.md` 的三个借鉴（实现细节与诚实评估）：
- **市场 regime 标记**（services/ai-screen/regime.ts）：market_breadth MA55上方占比 + rps_scores ret_20 全市场中位数 → attack/neutral/defense；**只标记不拦截**（run.marketRegime 落库 + AiScreenTab 徽章 + defense 时 degradation 加 market_defense_regime）。阈值 0.35/0.55/-4% 是拍的未验证；价值兑现点在「胜率复盘按 regime 分段」（未做）。同文件 `tradingDayLag`：barDate 工作日滞后 ≥2 → degradation `stale_bars_lagN`（法定节假日未剔除，长假后可能误报，仅标记无害）。
- **箱体因子**（lib/box.ts 译自 signals.py）：分位 S/R + 斜率/R² 拒通道 + 触及/摆动/漂移/中部占比 → boxQuality 0-100。**零权重观察因子**：enrich 计算后以 `factorScores.box` 随 JSON 落库（不加 DB 列），IC 验证走 optimize-params B2 的 FACTOR_KEYS 加 'box'。**风险：候选池已被 RPS≥70 过滤（热门票池），箱体票天然稀少可能大面积 null → IC 难显著**。→ 当日稍晚已按此判断把箱体加进**全市场扫描器**（无 RPS 前置才是正宗用法）：/api/scan 加 `box=in|breakout`；扫描页「吸筹箱体」行（箱体内/已突破）；backtest-scan-phases 同步加两组。**当晚再升级为预计算物化**（弃 TS 逐只即时算）：新表 `stock_box`（只落 in_box/breakout 行）+ `scripts/compute-box.ts`（run-daily 每日跑，fatal:false；--init 60日 / --backfill=N 深回补；in_box 窗口含当日、breakout 窗口锚定前一日+量≥1.6×箱均量+涨幅2~9.5%）；扫描器 cand 预筛直接 JOIN（箱体票集先砍窗口计算量），表无当日数据时回退 TS 即时算兜底。部署：migrate-stock-box.sql + prisma generate + 可选 compute-box --init 播种。后续红利：突破箱体可做预警规则（读 stock_box breakout）。
- **漏斗审计**（scripts/audit-ai-screen-funnel.ts）：enrich 改 export `enrichWithReason`（引擎共用同一逻辑），跑 L1 SQL池→L2 enrich(主因分布)→L3 打分分布→L4 风险层→L5 topN + 瓶颈诊断 + DB 侧近10次run/近30日入选风险画像。
- **部署**：服务器跑 `scripts/migrations/migrate-ai-screen-regime.sql`（runs 加 market_regime 列）+ prisma generate。

另：全市场扫描器同日重做（阶段预设+趋势条件行，见 scanner store v10），配套归因回放脚本 `scripts/backtest-scan-phases.ts`（对照组=RPS60≥87、单条件/预设/消融/阈值扫描、T+1收盘入场、前复权、分年拆分），服务器上 `npx tsx scripts/backtest-scan-phases.ts` 跑，输出直接指导 UI 档位默认值。

## 2026-08-11 LLM重排分片化（实验驱动定稿）
**背景**：08-10 起 topK 从 15 恢复到 50 后 LLM 重排 100% 失败（思考烧光 12288→content 空→json_parse_failed→回退纯规则）。
**三轮实验结论**（同批 50 候选，momentum）：
- 思考长度**不随候选数缩减**——50 一次喂 0/2 成功；分片 10 全思考仍 3/5 片烧光；`reasoning_effort:"low"` 是建议非硬约束，单用 1/3 成功
- **唯一 100% 可靠组合 = 10/片 + 低思考 + 并行**（3/3 次 15/15 片，~30s，~19k token/次 vs 旧版白烧 12k 零产出）
- 胜出配置自一致性：top30 重合 23/30、Spearman 0.506（分数集中 65-85 窄带的正常抖动；final=0.6screen+0.4llm  damped 后头部稳定）。想再压噪可双跑取均分（未做）
**实现**（ranker.ts + prompt.ts）：
- `SHARD_SIZE=10`，toScore 切片 `Promise.all` 并行；片内仍 1 次重试；片级降级日志带 `shard{i}:` 前缀
- 片间标尺 = 静态分数带（`buildShardPoolContext`：90+=多因子共振+板块催化…0-39=规避）+ 全池 identity 行（保留跨股比较视野）+ 已有分的 alreadyScored 参照（增量续打锚），三锚并存
- `callLlm` 请求体加 `reasoning_effort:'low'`；400 降级重试时**去掉该参数**（严格中转不认会 400）
- 全局覆盖率改从 pick 实际状态算（toScore.filter llmScore!=null），market_view 等全局字段取首个成功片的 payload
- 服务器 baseUrl 是 DeepSeek 官方（支持 reasoning_effort）；`chat_template_kwargs.thinking=false` 实测**无效**
- 顺带清理：deep_analysis_records 的 action 脏值（`** 持有`/`观望`/`（买入）`）已归一化，engine.ts 加 `normalizeAction()` 根治
**待观察**：跑几周后看胜率复盘 LLM A/B（纯screen/融合/否决）决定 RANK_WEIGHT=0.4 去留；若噪声嫌大可加双跑均分。

## 2026-08-15 十年回测调权落地（A1/C/D 全执行）
10 年报告（20161208~20260717，2332 交易日，IS1632/OOS700）复核 680 天结论后落地：
- **权重**（strategies.ts 四 preset）：trend/liquidity/theme_heat **清零**（momentum/balanced；quality/defensive 轻砍）——trend OOS -0.056~-0.065、log成交额全市场 IC -0.083（t=-29 全场最强）跨牛熊稳定反向；entry_timing 上调（momentum 0.45/balanced 0.55，唯一强正 +0.039/+0.057）；risk 保留（T+20 最强 +0.056/+0.074）；chip 符号不稳维持 0；quality 未来函数人工保留。
- **D 项拍板**：删 risk() 回撤罚项（dd20 IC 两窗口稳定正 +0.045/+0.050，深回撤=超跌反弹，罚它是反的），risk 只留 vol+ATR；risk_drawdown_* 配置键已删。不加 dd20 正项（与 entry_timing 回踩相关防双计）。
- **⚠️ 新发现（后续大项）**：**候选池 10 年全周期跑输市场**（池超额 balanced -0.22%/momentum -0.27% T+5 日均，680 天窗口为正）——动量池是牛市产物，评分器池内有效（Top20 捞回 -0.05%），拖后腿的是池构建。方向=弱市门控（接上 08-14 regime 标记的拦截角色），待立项。
- 建议权重(线性OOS) Top20 未跑赢当前权重 → 只取方向保守调，没照抄建议列。
- 跑数运维坑（详见 doc）：backtest-factors 全量峰值 ~2.8GB 须 `--max-old-space-size=3584`；后台跑必须 `setsid`（nohup 护不住 npx 子进程收 SIGHUP）；大回补后必须 ANALYZE rps_scores/daily_bars 否则后续脚本卡死。

## 2026-08-19 规则分门槛 + 入选数下调（数据驱动定稿）
用户：「行情差时规则分全 30 几还强行排不合理」「入选 30 个太多、后排规则分常 <50」。拉服务器 7 交易日(08-10~18)历史入选标的 screen_score 分布校准后落地：
- **门槛改成每策略字段 `StrategyPreset.minScreenScore`**（缺省 `DEFAULT_MIN_SCREEN_SCORE=50`，旧预设 quality/defensive 回退）：`engine.runScreen`/`rescueRun` 选中前先 `screenScore >= minScreenScore` 过滤，不满 N 就少选；`[runId]` 展示层同步（按 run.strategyId 取门槛）
- **momentum=45 / balanced=40**（数据结论）：momentum 分数自带市场信号（p50 好市 50.6/弱市 43，45 正好卡中间→强市满 20 弱市剩 7）；balanced 分数被压扁（中位数 37、p50 全程 34.5~38.9 不随市场走）→ 门槛只能是「质量地板」，40 砍掉 32-40 的平庸尾巴（~8-12 只）
- **maxOutput 30→20**（balanced/momentum）；前端 AiScreenTab 空态区分「无 run」vs「run 但 0 入选」；rulesText 加「规则分门槛：≥40/≥45」行 ——（08-21 已回改：maxOutput 20→30、momentum 门槛 45→40，见下节）
- ⚠️ **语义反转**：08-05/08-11 的「LLM 遗珠捞 31-50」被门槛覆盖——规则分 < 门槛候选即使 LLM 拉高也不入选
- **LLM 重排同步收口**：ranker 只送 `screenScore ≥ 门槛` 的候选给 LLM（过滤提前到输入侧），弱市省 70%+ token、坏市全灭时自动跳过 LLM 不调；入选结果不变
- ⚠️ **待立项**：balanced 权重失真（entry_timing 50% 压在 RPS≥70 动量池→分数塌在 35-40），需攒够数据（尤其撞一次真正 defense 期）后回测调权，不是门槛能修；45/40 是一阶估计，几周后回看 ——（08-21 已落地，见下节）

## 2026-08-21 打分横截面化 + 5/13 金叉（落地 08-19 待立项）
- **entry_timing 改池内横截面排名**（`scorer.rankScore`，最好 100/最差 0、NA 中性 50）：绝对分在 RPS≥70 动量池内被压扁（多数 ∈[5,25]），单调变换展开到 0-100——Spearman IC 不变（10 年「唯一强正」结论保留），screenScore 回归市场中性；「质量地板」改由 quality/risk/trend 等绝对因子托底。
- **新增 cross13 二元因子**（5/13 金叉，镜像 alertRules R04，权重 0.05）：`indicators.maCross13`（近 5 根 MA5 上穿 MA13 + 今日量>前5日均量×1.2，窗口较 R04 放宽）；`stats/route.ts` 的 FACTOR_KEYS 加 `cross13`；与 box 同模式待 IC 验证。
- **momentum 删 `requireMaBullish` 多头硬筛**（10 年回放反指）；trend() 内 maBullish 加减分同步移除（`trend_ma_bullish_bonus/penalty` 配置键删除）。
- **权重再平衡**：balanced entry 0.50→0.35 / quality 0.25→0.30 / risk 0.20→0.25；momentum entry 0.40→0.30 / quality 0.20→0.25；box 0.05 / cross13 0.05 两侧保持。
- **门槛/入选数回改**：maxOutput 20→30、momentum minScreenScore 45→40（balanced 保持 40）——08-19 的 45/40 是横截面化前的一阶估计，分数中性化后放宽。
- **删除 applyPortfolioOverlay 死代码**（组合分散层 08-14 已随 portfolioProfile 移除，08-21 清理 risk.ts 残留函数与桶映射）。

## 既有架构(未变)
- L1 候选池SQL:`services/ai-screen/candidates.ts`(array_agg 近60根OHLCV+基本面+行业,LIMIT 200,按RPS倒序)
- LLM重排:`ranker.ts` RANK_WEIGHT=0.4,融合 final=screen*0.6+llm*0.4;`prompt.ts`;覆盖率≥0.6门控+1重试+JSON容错
- 风险层:`risk.ts`(读pick字段,与因子解耦)
- 多用户共享:`@@unique([strategyId,barDate])`首跑花token后续秒取;v4门控仅DeepSeek v4+落库;降级rescueRun补救
- API:`app/api/ai-screen/route.ts`(POST跑/GET历史)、`[runId]/`(详情+板块过滤)、`stats/`(胜率复盘)
- **列名陷阱**:见 [[project-architecture]] DB节;T+N用Prisma client规避
