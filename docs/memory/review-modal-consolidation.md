---
name: review-modal-consolidation
description: 复盘弹窗(ReviewModal)结构：顶部2tab=周报/胜率复盘，胜率复盘内嵌3子tab=深度分析/AI筛选/预警规则；AI页胜率入口已删；2026-08-19改纯数据向(砍推荐榜/刷新头部)
metadata: 
  node_type: memory
  type: project
  originSessionId: 3d2ddbf8-bb61-420a-a94a-0e470c388de8
  modified: 2026-08-19T06:37:08.286Z
---

2026-08-07 用户反馈"两个地方放了胜率面板、内容加乱了"，把所有复盘/胜率面板从 AI 页剥出，与周报融合收拢到**预警首页「复盘」按钮**（原「周报」按钮升级，icon BarChart3）。

**现状结构**（2026-08-19 纯数据向）：
- `components/ReviewModal.tsx` — 唯一复盘入口。Modal(center, sm:max-w-4xl) + sticky tab 条。**顶部 2 tab：`weekly 周报 / stats 胜率复盘`**；stats 内嵌二级 tab：`deep 深度分析 / screen AI筛选 / rule 预警规则`。tab 条件渲染（切到才挂载拉数，切走卸载）。
- `components/ai/WeeklyReview.tsx` — 原 WeeklyReviewModal 剥掉 Modal 外壳后的纯内容组件（文件已改名，旧文件删除），仅被 ReviewModal 用。
- 三个胜率面板组件：`DeepAnalysisStats` / `AiScreenStats` / `AlertRuleHealth`（共享 stats-primitives.tsx）。
- **2026-08-19 改纯数据向（用户"没人看，做成给我自己看的"）**：砍掉①深度分析的「优质买入建议榜」+ next/link 跳转（连同 deep-eval/stats 的 topPicks 计算一并删）②三面板共用的 `StatsHeader`（说明文案+刷新按钮，已从 stats-primitives.tsx 删除）。保留：tooltip/空态引导、`TuningDetails` 折叠区。数据只在切 tab 挂载时拉一次，无手动刷新入口。
- **两层结构**（2026-08-07 二轮整理）：决策层默认展开（整体卡/榜单），调优层收进底部 `TuningDetails` 折叠区（stats-primitives.tsx 提供，Wrench 图标+hint 文案）。深度分析 tab 折叠=月度趋势+大盘分桶+置信度/仓位校准；AI筛选 tab 折叠=月度趋势+因子IC+LLM A/B+事件信号（全空时不渲染折叠条）。新增统计块默认归调优层。
- AI 页清理：`app/ai/page.tsx` deepTab 只剩 chat/history（stats 分支与两面板 import 已删）；`AiScreenPanel.tsx` 已整个删除（AI筛选迁扫描页 tab，见 [[ai-screen-feature]]）。

## 周报内容口径（2026-08-07 用户不满"信息量小+没胜率+顶部纯文字"后重构）
- 数据源 `scripts/generate-weekly-review.ts`（周五 18:00 cron），payload 单一事实源存 weekly_reviews
- **结构**：顶部「本周速览」KPI 网格（涨跌比/筛选T+1胜率/做T命中/预警/深度/涨停，替代纯文字总结，summary 只留一行浓缩）→「本周胜率」区块 → 各功能明细
- **胜率口径（关键：回填时效）**：AI 筛选 T+1（ai_screen_evals nDays=1 次日回填，周五生成时本周基本全）+ 做T 次日命中（tscore_records nextDayReturn，buyScore>sellScore=买点次日涨算中，反之为卖点次日跌算中）。**深度分析 T+5/10/20 与预警 t5/t10 滞后 ≥5 交易日，本周报算不出**（复盘弹窗其他 tab 有完整胜率，周报不重复）
- **市场情绪**（sentiment）：market_breadth 涨停/跌停/20日新高 + northbound_flow 北向资金周净流入
- 样本 <10 灰显"样本少，仅供参考"；warnings 各阶段就地标注、残缺分析不落库见 [[deep-analysis-feature]]

**Why**: 两处入口共用一个「胜率复盘」名字但内容各不同（分析tab=规则健康+深度分析，筛选view=AI筛选），用户找不到东西。
**How to apply**: 以后新增复盘/统计类面板挂 ReviewModal 加 tab，别再往 AI 页塞；涉及 [[ai-screen-feature]] / [[deep-analysis-feature]] / 预警规则统计的展示层都走这里。
**已否决的加项**（2026-08-07 用户明确"先不加"，别再主动提）：胜率加大盘基准列、候选池基准对比、周报加累计胜率、样本成熟度提示、单标的历史轨迹。
