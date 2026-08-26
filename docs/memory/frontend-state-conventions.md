---
name: frontend-state-conventions
description: 前端状态与同步的长期约定——store persist 版本迁移、云同步 blob 版本兼容、分享写入闸门（幽灵标的根因）、复盘面板挂载规范与已否决加项
metadata:
  node_type: memory
  type: project
  modified: 2026-08-24T01:50:00.000Z
---

自选/分组/云同步/分享/复盘四块的**长期约定**。实现细节已完工，不再赘述（考古走 git log）；这里只留「下次改动必须遵守」的部分。

## store 持久化（zustand persist → localStorage）

- 自选**纯客户端**：`stock-alert-store`，无 DB 无 API，服务端无法识别用户。分组同样纯前端。
- **v3 多组映射**：标的无组概念（`Stock` 无 `groupId`），`WatchlistGroup` 持有 `stockCodes: string[]`，一个标的可同时在多组；「全部」= watchlist 全量去重，无默认分组。
- 顺序语义：「全部」= watchlist 数组序；组内 = 该组 `stockCodes` 数组序。
- **改 store 数据结构 → 必须升 persist `version` + 写 `migrate`**（任意旧版 → 新结构）。
- **`partialize` 必须含 `groups`**（漏了分组不落盘，踩过）。

## 云同步（services/sync/engine.ts）

- 零知识：`syncKey` 只在设备上，服务器只存密文 blob + `keyHash`（写删鉴权）。**唯一设备全丢 = 数据无法恢复**，这是零知识的固有代价，用户已接受，别再提"加个找回"。
- **blob 版本**：v1 → v2（加 `data.devices`）→ v3（groups 持 stockCodes）。加同步内容 → 升 v + `applyRemoteBlob` 按 v 适配；**纯新增可选键可以不升版**（2026-08-17 `data.share` 就是软加，老客户端忽略未知键）。
- **回声抑制**：`applyRemoteBlob` 期间置 `applyingRemote` 跳过上传，否则两端互拉死循环。
- **内容 hash 防空传**：算 hash 前把 `packedAt`/`lastSyncedAt` 归零，否则每次都判定"有变化"。
- 冲突：409 = LWW 远端赢 + toast。限流在 `lib/rate-limit.ts`（内存实现，PM2 单进程够用）。
- `lib/sync-crypto.ts` 的 `toBuffer` 助手是给 TS5.7 typed-array 泛型用的（BufferSource 参数必须 `Uint8Array<ArrayBuffer>`），别"顺手简化"掉。

## 分享（services/share/engine.ts）

- 凭证模型：分享码 = **读**凭证（GET 免鉴权 + 限流 30/min/IP 防遍历）；`ownerToken` = **写**凭证，只存分享方本地。
- **【军规】自动上传前必须先 `checkAndPull()` 对齐云端**，且只在 watchlist/groups 引用变化时才调度上传。根因：分享 API **没有版本闸**（不像同步有 baseVersion 409），后写必赢 → 陈旧后台标签页会把过时分组发布出去，接收方看到「不存在的标的」（2026-08-17 幽灵标的事故）。
- 订阅列表本地 persist **不进** blob（换设备重输码）；我的分享状态 08-17 起**进** blob（多设备接管同码）。
- 撤销后订阅方保留最后快照，打 `dead` 标灰显删除线；upsert 成功自动复活。
- 孤儿码（token 丢失撤不掉）只能 SQL 删 `share_snapshots`。

## 复盘面板（components/ReviewModal.tsx）

- **唯一复盘入口**在首页「复盘」按钮。新增复盘/统计类面板 = 往 ReviewModal 加 tab，**别再往 AI 页塞**（2026-08-07 用户反馈"两个地方放胜率面板、找不到东西"）。
- 两层结构：决策层默认展开，调优层收进底部 `TuningDetails` 折叠区（stats-primitives.tsx）。**新增统计块默认归调优层**。
- 纯数据向（2026-08-19 用户"没人看，做成给我自己看的"）：无手动刷新入口，数据只在切 tab 挂载时拉一次；已砍掉推荐榜与 `StatsHeader`。
- 周报口径：`scripts/generate-weekly-review.ts`（周五 18:00 cron）产出 payload 存 `weekly_reviews` 单一事实源。**深度分析 T+5/10/20 与预警 t5/t10 滞后 ≥5 交易日，周报算不出**（复盘弹窗其他 tab 有完整胜率，周报不重复）。样本 <10 灰显"仅供参考"。
- **已否决的加项（用户明确"先不加"，别再主动提）**：胜率加大盘基准列、候选池基准对比、周报加累计胜率、样本成熟度提示、单标的历史轨迹。

相关：[[project-architecture]]；各功能的统计口径见 [[ai-screen-feature]]、[[deep-analysis-feature]]。
