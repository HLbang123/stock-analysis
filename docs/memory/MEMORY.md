# 项目记忆索引

本目录沉淀本项目的长期约束/军规/功能决策（原 Claude Code memory，2026-08 迁移入仓、已版本化）。
开工前先读本索引，按任务类型读对应条目。**记忆条目是历史事故换来的规则，优先级高于默认判断。**

## 军规 / 硬约束（涉及相关任务必读）

- [十年数据军规](ten-year-data-scale.md) — 2026-08-15 起库是 10 年全量（daily_bars 1080 万行 / rps_scores 1035 万行）；写脚本/SQL 前必读 8 条：日期边界 / 内存估算 / 窗口双边界 / DISTINCT 配 LIMIT / 大批量写后 ANALYZE / setsid+3584 堆+串行 / 先小窗试跑 / build 与批处理不并发；附 2026-08 OOM/load 事故清单。
- [服务器信息](server-info.md) — 硅云香港 CVM 103.151.217.28（2 核/3.8G）；SSH/nginx/PM2/防火墙；**链式部署一行命令**；**别跑 `prisma db push`**；PG 在 docker 容器 `stock_pg` 已调优（shared_buffers=1GB 等）；三铁律 setsid+3584 堆+串行链；大批量写后必须 ANALYZE。
- [预警规则辐射地图](alert-rules-refactor-plan.md) — 14 条 R01-R14；改规则 ID/条件先查此地图：事实源 `services/alertRules.ts` + 消费方（deepAnalysisPrompt / levels buyIds / scorer CRITICAL_SELL / page 共振 / modal / docs）；**08-17 买入侧十年回放首批调整**（R08/R11 参考级、R06 降 B、R10 升 A、删长上影/长下影/封板、巨量≥4x 升 sev5、全规则去仓位化、R12 改名站稳五日线）；强卖出（sev≥3）才染绿整卡/摘买入徽章。
- [合规命名口径](naming-compliance.md) — 对外可见处禁用「股」字（含股票/选股/荐股/个股/A股），用「标的/筛选/行情」替代；内部代码命名不限。
- [UI 文案原则](ui-text-principles.md) — 用户不要解释性文本：禁提模型名/数据源/统计术语/脚本名；副标题一句砍、tooltip 一句内、空态一句；更新日志只写用户可见功能、一条一句。
- [更新日志合并偏好](changelog-merge-preference.md) — 同一天同一功能区改动合并成一条，不拆细碎条目（用户明确要求）。
- [git 推送习惯](user-git-habits.md) — 默认不提交不推送交给用户；用户自己 squash 成一笔中文 feat 直推 main，force-push 可接受。
- [规则说明同步坑](rule-doc-sync.md) — 改规则/扫描条件/波段打分后，首页「规则说明」弹窗只有预警 tab 自动读 alertRules；市场扫描/波段打分 tab 手写静态、`docs/alert-rules.md` 也手写，都要手动同步。

## 架构 / 工具

- [项目架构地图](project-architecture.md) — 目录结构一览（页面/API/数据源/DB/服务/store/脚本/鉴权）；middleware 已改 `proxy.ts`；代码定位已移交 CodeGraph。
- [CodeGraph 代码图谱](codegraph-tooling.md) — CLI+MCP 全局装好、项目索引自动同步；explore/query/impact 定位首选；升级/卸载/重建命令备查。
- [十年数据消费地图](ten-year-consumer-map.md) — App 最多 4 年数据（日 K 1000 天、其余 ≤1 年；10 年仅供回测+AI 工具）；DISTINCT ON+ANY 是大表雷、改 LATERAL 点查根治 load 尖峰；ANALYZE 已自动化；分区迁移已取消。

## 功能实现笔记

- [AI 筛选功能](ai-screen-feature.md) — 胜率优先重构（7 因子去泄漏+全候选落库+T+N 回路+胜率复盘+板块过滤）；**08-15 十年回测调权落地**（trend/liquidity/theme_heat 清零、entry_timing 上调、risk 删回撤罚项；⚠️ 池全周期跑输市场→弱市门控待立项）；跑数坑 setsid+3584 堆+大回补后 ANALYZE。
- [深度分析功能](deep-analysis-feature.md) — 并行化重做（波 1 四并发+逐字直播+断网续跑+裁决韧性）；**08-10 数据新鲜度大修**（tushare 日线盘中恒 T-1、指数实时化走 /api/quote、T-1 全标注、moneyflow THS 字段错位修复）；prompt 数据内容只改 engine.ts。
- [波段评分功能](tscore-feature.md) — 买卖双信号分（因子确定分+LLM±15 微调）；做 T 规则 7 买+7 卖因子在 `services/t-score/scorer.ts`（改 DEFAULT_TSCORE_PROFILE/因子函数/权重）；/api/minute 加 8s 缓存+在途去重。
- [筹码峰功能](chip-distribution-feature.md) — 路线 B 换手率转移模型；`lib/chip.ts` 单一事实源+daily_bars 加 turnover_rate；生产需 ALTER TABLE 加列+`--backfill-chip` 回补。
- [ETF 功能调研](etf-feature-notes.md) — P0 已实现待部署（fund_profiles+分类器+R01 跳 ETF）；**08-18 P1 定稿：波动档阈值缩放+ETF_TSCORE_PROFILE+折溢价提醒**；网格交易已砍；迁移用 `scripts/_run-migration.ts` 在服务器跑。
- [自选分组功能](watchlist-group-feature.md) — v3 多组映射（分组持 stockCodes、标的无组概念）+persist 迁移 v3+云同步 blob v3 兼容；删除弹窗两选项+多选删除。
- [分享功能](share-feature.md) — 订阅制只读：明文快照+分享码读凭证+ownerToken 写鉴权；ShareModal 两 tab；部署需 migrate-share.sql+prisma generate。
- [多设备同步方案](sync-code-plan.md) — 配对码（6 位短码 10 分钟 TTL）+零知识加密快照+L2 自动同步；回声抑制/TS5.7 toBuffer 两坑已踩；08-12 加设备清单。
- [复盘面板收拢](review-modal-consolidation.md) — ReviewModal 顶部 2 tab（周报/胜率复盘）+胜率复盘内嵌 3 子 tab（深度/AI 筛选/规则）；AI 页胜率入口已删。
- [同花顺 fuyao 接入](fuyao-integration.md) — 龙虎榜（机构/游资席位）+前复权历史 K+THS 概念行业成分落库+**复权口径改造**（daily_bars 加 adj_factor）；dump 下载须带 /api 前缀；服务器待跑 migrate+backfill-adj。

## 已归档（历史参考，非当前约束）

- `_archived/accumulation-breakout-survey.md` — 吸筹突破调研（结论已落地进 AI 筛选）
- `_archived/frontend-refactor-2026-08.md` — 前端基础组件库重构（复用指导已并入架构地图）

## 数据 / 权限

- [tushare 积分](tushare-credits.md) — 6000 分：moneyflow（主力净流入）/stk_holdernumber（股东户数）可用；L2 逐笔需外部源。
