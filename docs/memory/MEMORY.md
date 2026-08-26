# 项目记忆索引

本目录沉淀本项目的长期约束/军规/功能决策（已版本化入仓）。
开工前先读本索引，按任务类型读对应条目。**记忆条目是历史事故换来的规则，优先级高于默认判断。**

> **维护约定**：写进这里的只能是「下次动手必须遵守的约束」。变更过程、已完工功能的实现细节、被后续结论覆盖的中间版本，一律不留——那些交给 `git log`。新增条目前先问一句：这是约束，还是历史？

## 军规 / 硬约束（涉及相关任务必读）

- [十年数据军规](ten-year-data-scale.md) — 库是 10 年全量（daily_bars 1080 万行 / rps_scores 1035 万行）。8 条军规：日期边界 / 内存估算 / 窗口双边界 / DISTINCT 配 LIMIT / 大批量写后 ANALYZE / setsid+3584 堆+串行 / 先小窗试跑 / build 与批处理不并发。含**消费地图**（App 只需 ~4 年，别为 10 年过度设计，分区已取消）、**DISTINCT ON + ANY → LATERAL 点查**改法、2026-08 OOM/load 事故清单。
- [服务器与部署](server-info.md) — 硅云香港 CVM 103.151.217.28（2 核/3.8G）；**凭证不入仓**；PG 在 docker 容器 `stock_pg` 已调优；**链式部署一行命令**；**别跑 `prisma db push`**；改 schema 必须先 `prisma generate`；自动化 SSH 用 SSH_ASKPASS（旧的"分类器拦 && / 单步指令"限制在 DSH 下已作废）。
- [预警规则辐射地图](alert-rules-refactor-plan.md) — 14 条 R01-R14；**改规则 ID/条件先查此地图**：事实源 `services/alertRules.ts` + 全部消费方（deepAnalysisPrompt / levels buyIds / t-score CRITICAL_SELL / 首页共振 / modal / docs）。含严重度分级、买入共振口径、复活键、盘中量能归一化；**规则说明弹窗只有「预警规则」tab 自动同步，市场扫描/波段打分两 tab 是手写静态**。
- [合规命名口径](naming-compliance.md) — 对外可见处禁用「股」字（含股票/选股/荐股/个股/A股/股市/股价），用「标的/筛选/行情」替代；内部代码命名不限。
- [UI 文案原则](ui-text-principles.md) — 不解释技术实现（禁模型名/数据源/统计术语/脚本名）；副标题一句砍、tooltip 一句内、空态一句；**更新日志只写用户可见功能、一条一句、同天同功能区合并成一条**。
- [git 推送习惯](user-git-habits.md) — 默认不提交不推送交给用户；用户自己 squash 成一笔中文 feat 直推 main，force-push 可接受。

## 架构 / 工具

- [项目架构地图](project-architecture.md) — 目录结构一览（页面/API/数据源/DB/服务/store/脚本/鉴权）；middleware 已改 `proxy.ts`；**DB 列名陷阱**（只有标 `@map` 的字段是 snake_case）；tushare 6000 积分口径；`lib/chip.ts` 筹码单一事实源。
- [CodeGraph 代码图谱](codegraph-tooling.md) — CLI v1.5.0 全局装好、项目索引自动增量（215 文件/2179 符号）；`codegraph explore/impact` 是定位首选；**MCP 当前没挂**（旧的 Claude Code 集成已失效），要挂看文中 `cordis.patch.yml` 写法。
- [前端状态与同步约定](frontend-state-conventions.md) — store persist 改结构必升 version + migrate（partialize 必须含 groups）；云同步 blob 版本兼容与回声抑制；**分享自动上传前必须 checkAndPull**（幽灵标的根因）；新统计面板挂 ReviewModal 别塞 AI 页 + 已否决加项清单。

## 功能实现笔记（活跃开发区）

- [AI 筛选](ai-screen-feature.md) — 当前管线/四预设权重表/门槛 40+入选 30/LLM 分片重排参数（均已对代码复核）；**已被十年回放推翻的结论**（trend·liquidity·theme_heat 清零、多头排列反指、回撤罚项删、箱体最强）；⚠️ 未解决：候选池十年全周期跑输市场（池构建问题，待立项）。
- [深度分析](deep-analysis-feature.md) — 波1 四并发 + R2 串行链 + manager 并入裁决；韧性**分两层**：非致命失败宽容降级+规则兜底，**致命 API 错误（401/403/404/402）不兜底直接冒泡**；数据新鲜度口径与 freshness 全景（哪些实时哪些 T-1）。
- [波段评分](tscore-feature.md) — 买卖双信号分（因子确定分 + LLM ±15 微调）；8 买 + 8 卖因子在 `services/t-score/scorer.ts`（改 DEFAULT_TSCORE_PROFILE / 因子函数 / 权重）；日内 30/60 分 K 拿不到，5/15 分 K 由 1 分时聚合。
- [ETF 功能路线](etf-feature-notes.md) — 不做 ETF 专属玩法，只让 ETF 在现有体系里信号更准；P0 已实现、P1 定稿（波动档阈值缩放 + ETF_TSCORE_PROFILE + 折溢价提醒）；网格交易已砍；tushare 积分不够 8000 已定论。
- [同花顺 fuyao 接入](fuyao-integration.md) — 已接入接口清单；**复权口径改造**（daily_bars.adj_factor + 已切/未切消费方 + 切换原则）；dump 单位换算（volume 股 / turnover 元）、`date_ms` 时区、adj_factor 推导公式等硬坑。

## 已归档（历史参考，非当前约束）

- `_archived/accumulation-breakout-survey.md` — 吸筹突破调研（结论已落地进 AI 筛选）
- `_archived/frontend-refactor-2026-08.md` — 前端基础组件库重构（复用指导已并入架构地图）

---

2026-08-24 精简：22 篇 → 14 篇。已删（活约束并入上方，其余属已完工实现细节）：chip-distribution / sync-code-plan / share-feature / review-modal-consolidation / watchlist-group（活约束抽进「前端状态与同步约定」）、changelog-merge-preference（并入 UI 文案）、rule-doc-sync（并入预警辐射地图）、tushare-credits（并入架构地图）、ten-year-consumer-map（并入十年数据军规）。考古走 `git log`。
