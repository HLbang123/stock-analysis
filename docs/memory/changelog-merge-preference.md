---
name: changelog-merge-preference
description: 更新日志同一天同一功能区的改动要合并成一条，不拆细碎条目
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 1462f5a9-8cf6-4e83-a287-91c0744bb4a7
  modified: 2026-08-21T02:40:20.734Z
---

更新日志（components/UpdateLog.tsx 的 CHANGELOG 数组）同一天、同一功能区的多处改动要**合并成一条**，不要拆成多条细碎条目。例如「AI 筛选打分调优」+「AI 筛选信号调整」应合并为一条，用顿号/逗号串联；不同功能区（如 AI 筛选 vs 深度分析）才分行。

**Why:** 用户明确要求「这种同类型的更新日志要合并」。细碎条目读起来冗余啰嗦，一条说清一个功能区更干净。

**How to apply:** 往 CHANGELOG 头部加新 `{ date, items }` 时，先按功能区归并——同一天同一功能（AI 筛选 / 预警 / 深度分析 / 自选…）的改动压成一条；只有确实跨功能区才另起一条。文案仍守 [[naming-compliance]]（禁「股」字）与 [[ui-text-principles]]（不解释、不列统计术语/模型名）。
