# 短线策略 AI 筛选 — 需求与验收清单

> 需求文档（requirements）。整理自正式口径 docs/short-term-strategies.md（唯一正式策略口径），
> 辅以 docs/dragon-first-yin-strategy.md（龙首阴探索稿）与 docs/memory/ 项目军规。
> 供后端（t2）、前端（t3）、验证（t4/t5/t8）直接执行。本文只做需求，不含实现。

## 0. 源文档与定位

| 源 | 角色 |
|---|---|
| docs/short-term-strategies.md | 唯一正式策略口径（规则定稿、十年回测、调参结果） |
| docs/dragon-first-yin-strategy.md | 龙首阴探索稿（含已确认口径、参数调优），规则以正式稿为准 |
| docs/memory/naming-compliance.md | 对外文案禁「股」字口径 |
| docs/memory/ui-text-principles.md | UI 文案精简原则 |
| docs/memory/ten-year-data-scale.md | 十年数据 8 条军规（日期边界 / 内存 / DISTINCT 等） |
| docs/memory/project-architecture.md | 目录 / API / DB 列名陷阱 / 部署 |

已存在原型（后续实现应复用而非重写）：
- lib/strategy/dragon-first-yin.ts、lib/strategy/limit-up-three-yin.ts、lib/strategy/double-dragon.ts
- scripts/test-dragon-first-yin.ts、scripts/test-short-term-strategies.ts

---

## 1. 范围与总原则

1. 三套策略互相独立，分开回测、分开展示：
   1. 涨停 + 三连阴
   2. 龙首阴
   3. 双龙战法
2. 所有策略只输出买入候选，不管理卖出。
3. 只做沪深主板：代码前缀 600 / 601 / 603 / 605 / 000 / 001 / 002 / 003。
4. 排除：创业板 300/301、科创板 688/689、北交所（4/8/9 开头）、ST、退市。
5. 退潮期 / 核按钮环境默认不输出候选（依据：跌停家数、炸板率、市场最高连板高度、market_regime）。
6. 历史回测只代表日线口径；盘口实时过滤不回测，接入时作为实时硬条件执行。
7. 输出为「候选列表 + 命中条件」，不输出买卖建议措辞（合规）。

---

## 2. 策略一：涨停 + 三连阴

### 2.1 规则（以第三根阴线为买入日 T）

| 位置 | 条件 |
|---|---|
| T-3 | 涨停日：收盘 ≈ 涨停价；非一字板（开盘价未触及涨停） |
| T-2 | 红盘高开：open > T-3 收盘；创新高：high > T-3 最高；当日收小阴线 |
| T-1 | 小阴线，真阴（收盘 < T-2 收盘） |
| T   | 小阴线，真阴（收盘 < T-1 收盘） |
| 量能 | T-3 量 > T-2 量 > T-1 量 > T 量 |

### 2.2 小阴线口径

- close < open（阴线）。
- 实体幅度 0.05% ~ 3.0%。
- 三根都必须是真阴：收盘价低于前一日收盘价，排除假阴。

### 2.3 买点与退出

- 买点：T 日尾盘买入。
- 实时过滤（不回测）：T 日尾盘 5 分钟应横盘或小幅下跌，不能快速拉升。
- 回测退出口径：次日最高价。

### 2.4 回测基线（参考，非验收）

- 第三阴收盘 → 次日开盘：样本 78，平均 -0.10%，胜率 55.13%。
- 第三阴收盘 → 次日最高：样本 78，平均 +2.72%，胜率 92.31%。
- 结论：信号稀少但次日冲高概率高；次日开盘基本无溢价。

---

## 3. 策略二：龙首阴

### 3.1 形态定义

- 连续涨停后出现第一根阴线 = 龙首阴。
- 3~4 板后首阴：假阴真阳优先，真阴保留但降级。
- 5 板及以上首阴：只做假阴真阳（收盘不低于昨日收盘）。
- 连板范围不设硬上限（代码 maxBoards=99 + highBoardThreshold=5）。
- 日内洗盘不一定是阴线：长下影的「分歧转一致」也视为龙首阴，如地天板式长下影。
- 首阴不能收在跌停价附近。

长下影分歧转一致的量化口径：

- 下影线 ≥ 收盘价 5%。
- 收盘价高于当日振幅中点。
- 收盘价高于昨日收盘。
- 量能、换手、退潮期过滤照旧。

### 3.2 过滤条件（正式定稿值）

| 条件 | 值 |
|---|---|
| 首阴量比 / 前 5 日均量 | ≤ 2.0 |
| 首阴换手率 | ≤ 45% |
| 首阴实体幅度 | ≤ 7% |
| 换手板门槛 | 连板中至少一个非一字板，且换手率 ≥ 8% |
| 连续一字板 | 默认排除（由换手板门槛 minTurnoverRate=8 实现；skipAllOneWordRun 仅作兼容开关） |
| 高位板 | 5 板及以上只做假阴真阳 |

### 3.3 买点与两阶段信号

- T 日尾盘：输出 firstYinToday（当日构成首阴）。
- T+1 早盘：对昨日候选做刷新，输出 firstYinYesterday。
- T+1 实时过滤：9:25 集合竞价必须是涨停价，否则视为烟雾弹剔除。
- 打板：只给参考价，不代挂单。

### 3.4 调参后口径（正式推荐）

- 量比 ≤ 2、换手板门槛 8%：样本 169，平均 +4.67%，胜率 81.7%，+2% 概率 72.8%。
- 结论：钱在盘中冲高不在开盘；3~4 板与换手板更稳；5 板以上需假阴真阳过滤。

---

## 4. 策略三：双龙战法

### 4.1 首板条件（2026-08-27 定稿）

- 首板必须是实体板：非一字板。
- 不卡实体大小、60 日突破与放量。

### 4.2 二板条件

- 二板为连续第二个涨停。
- 只认「恰好二板」：二板前一天不能也是涨停（避免把 3 板及以上识别为双龙）。
- 实时过滤（不回测）：二板封板时间必须早于首板封板时间。
- 二板若为一字板，加分但不作硬性剔除。

### 4.3 买入方式

- 方式一 · 二板打板：二板接近封板时以涨停价买入；退出 = 第三天开盘价。
- 方式二 · 回踩买入：二板后 1~3 个交易日内回踩到 5 日线附近；回踩日缩量（成交量 < 前 5 日均量 × 0.8）；退出 = T+1 最高价。

### 4.4 回测基线（参考，非验收）

- 二板打板 3916 样本（尚未过滤「二板一字板买不进」「二板早于首板」实时条件，偏乐观）：开盘退出 +3.06%/胜率 69.25%，最高退出 +7.17%/胜率 88.56%。
- 回踩买入 1019 样本：开盘 -1.66%/胜率 28.85%，最高 +2.33%/胜率 75.17%。
- 本次接入口径：双龙打板按正式稿基线口径接入，不补「二板可成交」过滤回测；结果需标注该口径局限（偏乐观）。

---

## 5. 统一数据依赖

| 数据 | 用途 |
|---|---|
| daily_bars | 日线形态、连板、量能、换手率 |
| stocks | 名称、状态、板块过滤 |
| 涨停池 / 连板天梯（/api/fuyao/limit-up、/api/limit-up） | 实时龙头、连板高度、封板时间 |
| market_breadth | 涨停、跌停、炸板、市场情绪 |
| 当日分时 | 尾盘横盘、9:25 竞价、快速拉升确认 |

---

## 6. UI 需求

### 6.1 结构（两个主 tab + 三个子 tab）

- 主 tab 一「超短线」：内含三个子 tab：
  1. 涨停+三连阴
  2. 龙首阴
  3. 双龙战法
- 主 tab 二「趋势优选」：复用现有「趋势猎手」（momentum）预设逻辑，仅改名。
- balanced「稳健优选」从新 UI 移除，代码保留历史预设但不展示；新 UI 只有「超短线」和「趋势优选」两个主 tab。
- 现有「AI 筛选」入口位于 app/scanner/page.tsx 默认 tab（components/AiScreenTab.tsx，当前展示 balanced「稳健优选」+ momentum「趋势猎手」两张策略卡）。

### 6.2 行为

- 两个主 tab 可切换；「超短线」内三个子 tab 可切换。
- 每个子 tab 展示对应策略的候选列表 + 命中条件/核心字段（连板数、假阴真阳/真阴、首阴量比/换手、二板封板先后等）。
- 空态区分「无候选」与「未到运行时间/尚未生成」。
- 结果可沿用现有「一键加入自选」逻辑。

### 6.3 合规与文案（必须遵守）

- 对外可见处禁「股」字（含股票/选股/荐股/个股/A股），用「标的/筛选/行情」替代；「涨停/跌停/炸板/连板/龙首阴/双龙战法」不含「股」，可用。
- 不输出买卖建议措辞：只提示「形态符合」与强度分级。
- 不暴露实现细节（模型名、数据源名、脚本名、统计术语、内部规则编号）。
- 文案精简：副标题一句内、tooltip 一句内、空态一句引导。

---

## 7. 调度与两阶段运行

1. T 日尾盘 · 14:30 固定执行：跑出当日候选并落库（快照）。
   - 说明：运行时刻固定 14:30（captain 决议）。dragon-first-yin-strategy.md 的「14:50 后运行最合适」为旧建议，作废。
2. T+1 早盘：只刷新昨日候选（复用快照，不重新全市场扫），执行实时过滤：
   - 龙首阴：9:25 集合竞价必须涨停价。
   - 双龙：二板封板时间早于首板封板时间。
   - 涨停+三连阴：尾盘 5 分钟横盘/小幅下跌，不快速拉升。
   - T+1 早盘需在 9:25 竞价之后（竞价数据可用）运行。
3. 退潮期/核按钮环境：默认不输出候选。

---

## 8. 后端 API 需求（供 t2）

- 三套策略都能通过后端 API 返回候选。
- 支持两阶段参数（T 日尾盘落库 / T+1 早盘刷新）。
- 调度入口存在且可配置（14:30 固定）。
- 返回结构包含：候选标的（代码/名称）、命中条件、形态关键字段（连板数、首阴类型、量比、换手率、封板时间先后等）、信号类型（firstYinToday / firstYinYesterday 等）、市场环境（退潮期标记）。
- 实现约束（军规，必须遵守）：
  - 不跑 prisma db push（孤儿行会卡）；改 schema 先 prisma generate，建表走 raw SQL。
  - DB 列名陷阱：只有标 @map 的字段是 snake_case；DailyBar.tsCode/tradeDate、RpsScore.tsCode/calcDate 是 camelCase，raw SQL 带双引号。
  - SQL 必须带日期边界 + 候选集双边界；DISTINCT tradeDate/calcDate 配 LIMIT；大批量写后 ANALYZE；大脚本 3584 堆 + setsid + 串行；先小窗试跑。
  - 不硬编码凭证；凭证走环境变量。

---

## 9. 已决议（captain 决议，实现以此为准）

1. 龙首阴连板范围：3~4 板允许真阴/假阴；5 板及以上只做假阴真阳，不设硬上限。代码 maxBoards=99 + highBoardThreshold=5。
2. 连续一字板：默认排除，由换手板门槛 minTurnoverRate=8 实现；skipAllOneWordRun 仅作兼容开关。
3. balanced「稳健优选」：从新 UI 移除，代码保留历史预设但不展示；新 UI 只有「超短线」和「趋势优选」（momentum 改名）。
4. 运行时刻固定 14:30。
5. 双龙打板本次接入按正式稿基线口径，不补可成交过滤回测；结果需标注该口径局限（偏乐观）。

---

## 10. 验收清单（供 t4/t5/t8 执行，逐条可验证）

> 验证手段：单测（UT）/ 类型检查（TSC）/ 构建（BUILD）/ 接口（API）/ 端到端（E2E）。

### A. 策略规则与参数（对应验收「与正式文档一致」）

- A1 涨停+三连阴：T-3 涨停非一字、T-2 高开创新高收小阴、T-1/T 真阴小阴、量能四日递减、实体 0.05%~3.0%（UT：scripts/test-short-term-strategies.ts）。
- A2 龙首阴：首阴量比 ≤2.0、换手率 ≤45%、实体 ≤7%、换手板门槛 ≥8%、高位板只做假阴真阳（UT：scripts/test-dragon-first-yin.ts）。
- A3 双龙战法：首板实体 ≥5%、突破 60 日高、量 ≥前5日均×1.5；二板连续涨停；封板时间先后（实时）（UT 覆盖日线部分）。
- A4 主板范围过滤：600/601/603/605/000/001/002/003 通过，300/301/688/689/4/8/9 与 ST/退市剔除（UT）。

### B. UI 行为（对应验收「主 tab / 子 tab」）

- B1 两个主 tab「超短线」「趋势优选」渲染正确，可切换（BUILD + E2E）。
- B2 「超短线」内三个子 tab「涨停+三连阴 / 龙首阴 / 双龙战法」可切换（BUILD + E2E）。
- B3 结果卡片展示策略核心字段（形态/连板/量比/换手等）（E2E）。
- B4 对外文案禁「股」字、无买卖建议措辞（review / 静态检查）。

### C. 运行时间（对应验收「14:30 + 两阶段」）

- C1 T 日尾盘 14:30 固定执行入口存在且可配置（API / 调度脚本存在，E2E 触发路径可验证）。
- C2 两阶段：T 日尾盘跑全量候选并落库；T+1 早盘复用快照只做实时刷新，不重扫（API 参数 + 行为验证）。

### D. 可执行性（对应验收「每项可被后续验证任务执行」）

- D1 单元测试通过：scripts/test-short-term-strategies.ts 与 scripts/test-dragon-first-yin.ts 均 0 失败。
- D2 类型检查通过：npx tsc --noEmit 无错误。
- D3 构建通过：npm run build 成功。
- D4 端到端：页面可访问，三套策略结果可展示；14:30 调度触发路径可验证。

---

## 11. 相关文件（实现参考）

- docs/short-term-strategies.md（正式口径，唯一事实源）
- docs/dragon-first-yin-strategy.md（探索稿 + 调参）
- lib/strategy/dragon-first-yin.ts、lib/strategy/limit-up-three-yin.ts、lib/strategy/double-dragon.ts（原型，应复用）
- scripts/test-dragon-first-yin.ts、scripts/test-short-term-strategies.ts
- components/AiScreenTab.tsx、app/scanner/page.tsx、store/ui-store.ts（现有 AI 筛选 UI）
- services/ai-screen/strategies.ts（趋势猎手 momentum 预设）
- scripts/run-daily.ts（现有 16:00 日任务调度，14:30 为新增独立调度）

---

## 12. 实现与验收状态（t2~t8 完成后同步）

### 12.1 交付物

- 后端：services/short-term-strategies/{types,config,engine,data-source,market,persist,realtime,scanner}.ts；app/api/short-term-strategies/route.ts（GET 读快照 / POST 两阶段触发）。
- 调度：scripts/run-short-term-strategies.ts（14:30 固定，SHORT_TERM_SCAN_TIME 可覆盖）；scripts/migrate-short-term-tables.ts + scripts/migrations/migrate-short-term-signals.sql（raw SQL 建表，不跑 prisma db push）。
- 前端：components/ShortTermTab.tsx（超短线三子 tab）、components/AiScreenTab.tsx（两个主 tab）、store/ui-store.ts（选中态持久化）。

### 12.2 验收结果（全部通过）

- 单元测试：scripts/test-short-term-strategies.ts / test-dragon-first-yin.ts / test-short-term-scan.ts 均 0 失败。
- 类型检查：npx tsc --noEmit exit 0。
- 构建：npm run build「✓ Compiled successfully」。
- 评审：后端 t6 verdict=pass，前端 t7 verdict=pass。
- 端到端：/scanner 页面登录后 HTTP 200；/api/short-term-strategies 路由接线正确（POST /api/auth 签发 cookie 后可达，非 404）。

### 12.3 环境限制说明（非代码缺陷）

- 本验证沙箱无 Postgres（localhost:5432 ECONNREFUSED），故「三套策略落库快照的真实渲染」未能在线验证；该数据链路已由 test-short-term-scan.ts（三套策略产出候选 7/7 PASS）+ t4 API 结构核对 + t5 前后端字段对齐覆盖。生产/有库环境跑 14:30 closing 落库后即可展示。
- 14:30 调度入口可执行：npx tsx scripts/run-short-term-strategies.ts 已实测打印「调度时刻配置: 14:30 (SHORT_TERM_SCAN_TIME 可覆盖)」与「phase: closing strategies=all」，随后在 DB 边界失败（无库）。

### 12.4 文案口径最终落地

- 第二个主 tab 最终标签采用「趋势优选」（需求原文写作「短线的筛选」）；其内复用 momentum 预设，展示名「趋势」。