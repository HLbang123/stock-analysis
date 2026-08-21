---
name: watchlist-group-feature
description: "自选分组功能；v3 起为多组映射(分组持有stockCodes、标的无组概念)+persist迁移v3+多选删除；纯客户端无后端"
metadata: 
  node_type: memory
  type: project
  originSessionId: 86502ff8-3fa0-4ca5-911a-7f0fb55fab1a
  modified: 2026-08-15T05:37:58.885Z
---

自选分组功能（2026-08-04 建，2026-08-12 升级 v3）：自选纯客户端（zustand persist → localStorage `stock-alert-store`，无 DB 无 API，服务端无法识别用户），分组同样纯前端。

**约定（v3，2026-08-12 多组映射）**：**标的无组概念**——`Stock` 去掉 `groupId` 字段，`WatchlistGroup` 持有 `stockCodes: string[]`，分组只是「全部」里的子集映射，一个标的可同时在多个组；「全部」= watchlist 全量去重。无默认分组。

**store actions**（store/index.ts）：
- `addToWatchlist(stock, groupId?)`：新增标的；已存在时若给 groupId 补入该组（不重复）
- `toggleStockGroup(code, groupId)`：勾选/取消分组归属（复制语义，替代旧 moveStockToGroup）
- `deleteGroup(groupId, withStocks?)`：仅删分组 / 连标的删（其他组也有的保留）
- `removeStocks(codes[])`：多选删除（自选+所有组+预警一并清）
- `moveStocksToGroup(codes[], targetId|null, fromId?)`：多选移动分组（加入目标组去重+从来源组移出；targetId=null 仅移出）
- `reorderStocks(orderedCodes[], groupId?)`：拖动排序。groupId 缺省=排 watchlist 数组（「全部」顺序）；给了=排该组 stockCodes（组内独立顺序）

**持久化迁移**：persist `version: 3` + `migrate`（任意旧版 → 滤 'default' 组 + 标的 groupId 收集进对应组 stockCodes）。**partialize 必须含 groups**。改 store 数据结构时继续走版本迁移机制。

**云同步（services/sync/engine.ts）**：blob **v3**（groups 带 stockCodes、标的无 groupId）；applyRemoteBlob 兼容 v1/v2/v3——v1/v2 快照的标的 groupId 收集进 groups.stockCodes（与本地 migrate 同口径）。改结构 → v4 + 按 v 适配。

**UI**：GroupBar（tab 计数=stockCodes.length）+ GroupManageModal（删除弹窗两选项：仅删分组/连分组自选一起删，2026-08-15 起默认仅删分组且每次打开重置）+ MoveToGroupMenu（多选勾选，标题"分组（可多选）"）+ watchlist 页多选（长按卡片 500ms 或头部「多选」进入；头部全选/全不选；底部栏=移动分组+删除；移动弹窗在「全部」下=纯加入、具体组下=移出当前组加入目标组；切组自动退出多选）。**排序（2026-08-15）**：「全部」顺序=watchlist 数组序，组内顺序=stockCodes 数组序（visibleWatchlist 按 stockCodes 映射生成）；多选模式卡片右侧 ☰ 手柄 pointer 拖动（elementFromPoint 定位插入位、被拖卡 pointer-events:none、拖动中只动本地 dragOrder 松手才提交）；watchlistCodesKey 已 sort 后拼接，排序不触发行情重拉。首页预警分组过滤用 `Map<code, Set<groupId>>`。范围限定：预警/深度分析/回测不受分组影响。

相关：[[project-architecture]]
