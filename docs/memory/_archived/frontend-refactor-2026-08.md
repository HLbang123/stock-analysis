---
name: frontend-refactor-2026-08
description: 2026-08-04前端系统性重构；基础组件库/services/api.ts/AI页拆分；新代码应复用这些抽象
metadata: 
  node_type: memory
  type: project
  originSessionId: 86502ff8-3fa0-4ca5-911a-7f0fb55fab1a
  modified: 2026-08-04T08:33:44.701Z
---

前端系统性重构（2026-08-04，用户确认"凌乱"后一次性治理）。此前问题是"功能先于架构"导致大量重复实现。新写代码应优先复用以下抽象，不要另起炉灶：

**基础组件**（components/ui/）：`Modal`（sheet/center 两种 variant，统一弹窗壳）、`Input/Select/Textarea`（统一暗色样式）、`Tabs`（segment/pills）、`stats-primitives.tsx`（pct/signed/toneCls/Metric/StatsHeader/StatsEmpty，胜率复盘面板共用）。不要手写 `fixed inset-0 z-50 bg-black/40` 壳或 `border-gray-200 rounded-lg bg-white` 输入框。注意：**弹窗 overlay 必须 z-[60]**——底部导航 bottom-nav 是 z-50 且 DOM 在页面内容之后，同 z 值会盖住 sheet 弹窗底部（2026-08-04 修过；UpdateLog 抽屉是手写壳也已改 z-[60]）。

**数据请求层**：`services/api.ts` 的 `getJSON<T>/postJSON<T>/getJSONOr<T>`（统一错误处理，业务 error 抛 ApiError）。页面不要裸 fetch。API 响应类型集中在 `types/api.ts`。

**AI 页**：`app/ai/page.tsx` 已拆分（1248→750 行），深度分析的数据准备 + SSE 流解析 + verdict 解析在 `services/deep-analysis/engine.ts`（prepareDeepContext/runDeepAnalysisStream/parseVerdictContent）。改深度分析逻辑去 engine.ts，不要在页面内联。

**状态**：`store/ai-store.ts` 的 `LastSession` 已有类型（TScorePanelResult/DeepResult）；AiChat 的 chat 状态以 store 为单一事实源（不要本地 state 反写）。

**语义色**：A股红涨绿跌统一用 `lib/constants.ts` 的 `MARKET_COLORS`（图表）或 globals.css 的 `--color-up/--color-down` token（UI），不要硬编码 hex。

**设计 token**（2026-08-04 二轮，A+B 合并）：`app/globals.css` 建了完整 token 系统 —— 语义色阶（up/down/brand/accent/warning/danger 各含 soft/border，暗色自动切换）、圆角阶（--radius-sm/md/lg/xl）、间距阶（--space-section/card）、阴影阶（--shadow-card/hover/modal）。`Card` 组件提供 variant（default/bordered/accent/up/down/warning），`Button` 提供 8 种 variant 含 up/down。新写 UI 用 token 或基础组件 variant，不要写散装 rounded-xl/bg-red-500。

**信息架构**：预警页（app/page.tsx）卡片分扫读层（股名+强度+时间）+ 明细层（信号列表），买卖信号用左侧色条+语义色区分而非 emoji；AI 页操作区（Card bordered）与结果区用分隔线分开；个股详情页图表 tab 用 Tabs 组件。

相关：[[project-architecture]] [[watchlist-group-feature]]
