---
name: rule-doc-sync
description: 改预警规则/扫描条件/波段打分后，首页「规则说明」弹窗的手写 tab 与 docs 文档要同步
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 9f41917d-e96a-4dcb-9bf9-be359e35f271
  modified: 2026-08-15T06:47:08.340Z
---

改预警规则、扫描条件、波段打分逻辑后，必须同步首页「规则说明」弹窗（components/AlertRulesModal.tsx）里对应说明。**Why:** 2026-08-15 改完扫描条件后发现说明滞后——「规则说明」三 tab 里只有「预警规则」tab 是自动读 `ALERT_RULES`（services/alertRules.ts 单一事实源，自动同步）；「市场扫描」(ScanDoc) 和「波段打分」(TScoreDoc) 两个 tab 是**手写静态说明**，不跟代码走，改条件不会自动更新。

**How to apply:** 每次动 `services/alertRules.ts`（规则 ID/条件/级别）或扫描器条件（scanner 的筛选条件/阶段预设）或 t-score 规则后，检查：
- 预警规则：改的是 alertRules.ts 则 tab 自动同步，但 **docs/alert-rules.md** 是独立 markdown，需手动同步；
- 市场扫描/波段打分：直接改 AlertRulesModal.tsx 里对应的手写 DocItem 文案。

关联 [[alert-rules-refactor-plan]]（消费方地图，modal/docs 已列其中，此处强调"手写 tab 不自动"这一坑）。
