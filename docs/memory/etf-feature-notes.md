---
name: etf-feature-notes
description: ETF 功能路线：P0 已落地待部署；P1 定稿=预警阈值波动档缩放+ETF_TSCORE_PROFILE+折溢价提醒(fuyao nav已实测)；网格交易已砍(用户股票思维)；深度分析ETF数据块降P2
metadata: 
  node_type: memory
  type: project
  originSessionId: 5b4c6505-bc16-4f07-adef-d6164022c93c
  modified: 2026-08-18T07:16:51.215Z
---

ETF 功能路线（2026-08-14 与用户定稿）：

**总方针：不重做一套，三条核心路径全部复用架构 + 品种 profile 分层。**
- 预警 R01-R14：11 条纯价量规则天然适用；R13/R14 筹码禁用；R01 涨停/炸板子信号 ETF 关闭（宽基不可能涨停、无打板生态）；量价阈值按波动档(ATR)缩放，不跑回测
- T-score：scorer.ts 因子已全参数化，加 ETF_TSCORE_PROFILE 即可；sellDailyOverheat 摘掉 chip 项；T+0 品种做T价值更高
- 深度分析：编排复用；分析师 ETF 分支已有但需注入 ETF 数据块(跟踪指数/规模/折溢价/换手率)；心姐角色对 ETF 失效需变体为"指数/轮动分析师"；裁决 prompt 的 RPS≥90 引用对 ETF 去掉
- **ETF RPS 池砍了**（用户判断：ETF 本身代表一个行业，相对强弱用区间涨幅直接排序即可，不值得复制 backfill-rps 那套重 infra）；板块轮动面板降级为 P2 候选
- **不跑多年回测**：ETF 池小+年轻+清盘幸存者偏差，统计意义不成立；阈值用波动率缩放先验，靠 alert_rule_triggers + T+5 回填 + 胜率复盘做前向验证（需确认回填管道兼容 fund_daily_bars）
- 冒烟回放（只看触发频率不离谱）可选，用已有 fund_daily_bars

**数据源调查结论（2026-08-14）：**
- fuyao `get_fund_profile_detail` 很薄（名称/成立日/管理人/经理），品种分类用不上
- fuyao `/api/meta/tickers/list` asset_type 含 fund-etf/fund-lof → 权威 ETF 清单，替代前缀正则
- fuyao `/api/fund/performance/nav` 有单位净值+**adj_nav 复权净值** → 折溢价=收盘/净值-1（跨境溢价监控）；`/api/fund/performance/returns` 有区间收益（轮动排序现成）
- fuyao `/api/fund/market/historical` ETF 日线 adjust 固定 null 不复权，只能当备用
- **tushare fund_basic（2000分，已在用）= 品种分类主数据源**：fund_type(股票/债券/混合/货币/商品型)+invest_type(被动指数型)+list_date/delist_date+benchmark 文本
- **tushare etf_basic（8000分）**：index_code/index_name 跟踪指数 + etf_type(境内/QDII)；积分不够则解析 benchmark 文本兜底
- **tushare fund_adj（600分）基金复权因子** → 红利 ETF 除息跳空会致 R02 破位假信号（正确性问题，提到 P0）；fund_daily_bars 加 adj_factor
- tushare etf_share_size（8000分）：每日份额+总规模+净值+收盘价（清盘预警+折溢价+申赎动向）；积分不够则 fuyao nav 算折溢价
- ~~待确认：tushare 积分是否 ≥8000~~ → **已定：账号 6000 分，不够**（[[project-architecture]] 数据源节）。\`etf_basic\`/\`etf_share_size\` 用不了 → 跟踪指数解析 \`benchmark\` 文本兜底、折溢价走 fuyao nav。

**How to apply**: 动手顺序 = ①品种 profile 落库(fund_basic 分类+名称关键词兜底 T+0) ②预警适配(禁chip+R01裁剪+波动档缩放+复权修正) ③ETF_TSCORE_PROFILE ④深度分析 ETF prompt 包+数据块。基金快照换手率直接用不用自算。详见 [[fuyao-integration]] [[alert-rules-refactor-plan]] [[tscore-feature]] [[deep-analysis-feature]]

**P0 已实现（2026-08-14，待部署）**：
- `fund_profiles` 表（migrate-fund-profile.sql）+ `lib/fund-classify.ts` 分类器（22/22 单测过；踩坑：证金→保证金误伤、黄金股/黄金产业≠黄金商品、科创债ETF限幅恒10%）+ `scripts/sync-fund-profiles.ts`（fund_basic 全量含摘牌）
- `sync-fund-daily.ts` 清单源从 stocks 表正则切到 fund_profiles.is_active
- `checkAllRules` 加末参 `isETF`（跳过 R01 整条：涨停封板/炸板无意义+量比未标定），4 处调用方已传（stock详情/engine/ai页T-score/首页自选）
- 关键认知：live 预警 K 线走 sina/腾讯/东财**自带前复权**，红利 ETF 除息假破位在 live 路径不存在 → fund_adj 降级为仅回测/扫描需要；R13/R14 对 ETF 本就因 chip=null 自跳过
- 本地 PG 未运行，迁移+灌表须在服务器做：`scripts/_run-migration.ts`（新建的 SQL 执行器，pg adapter 不支持多语句故逐条跑）→ `sync-fund-profiles.ts --init`
**P1 定稿（2026-08-18，用户批准）**：
- **网格交易功能砍掉**：用户画像=股票思维、ETF 只是配置一环，网格教育成本远超价值；etf-grid-design/ezquant 已拉到 d:\tool\web\ 供参考但不再跟进（其 ATR 分档/资金反推思路留存）
- P1a 预警阈值按波动档缩放：价格类阈值（急跌/突破幅度）乘 ATR 比率系数，量比阈值不动；分档数据从 kLines 现算，不查表
- P1b ETF_TSCORE_PROFILE：computeTScore 加可选 profile 参数，分时阈值按波动档缩放，chip 加分项天然失效（chip=null）
- P1c 折溢价提醒：fuyao `/api/fund/performance/nav?fund_type=exchange&thscode=X.SH` **已实测**返回单条最新 {unit_nav, adj_nav}（注意 429 限流）；折溢价=现价/unit_nav-1；只对 cross-border/commodity 启用（equity 折溢价恒≈0 无意义）；nav 是 T-1（QDII 更滞后）文案须标注净值日期
- ETF 路线总叙事收敛：**不做 ETF 专属玩法，只让 ETF 在现有提醒/打分体系里信号更准、坑有提示**
- 原 P1 备忘：量比/急跌阈值按波动档缩放（用 fund_profiles.assetClass 分档）；T-score ETF profile；深度分析 ETF 数据块（折溢价走 fuyao nav）——其中深度分析 ETF 数据块降级为 P2
