---
name: ten-year-consumer-map
description: 10年数据消费地图——App只需1年(10年仅供回测+AI对话工具)；DISTINCT ON改LATERAL点查的排查模式；ANALYZE已自动化
metadata: 
  node_type: memory
  type: project
  originSessionId: c1728faa-d9e0-40f0-a19d-5d39d21bf9da
  modified: 2026-08-19T09:56:18.399Z
---

2026-08-19 load 尖峰排查结论（已修复落地）：

- **10 年数据消费地图**：App 实时查询最多 ~4 年（日K线图 `/api/kline/db` MAX_DAYS=1000 天；其余指标≤250天、RPS/扫描取最新）；真正扫 10 年的只有「回测」（月级离线）和「批量任务」（compute-rps/backfill/market-breadth，离线）。AI 对话工具（get_stock_rps / get_stock_history / get_chip_distribution）早已是点查/带日期边界。→ **别为 10 年数据过度设计**（分区迁移评估后取消）。

- **DISTINCT ON + ANY 是大表雷**：`SELECT DISTINCT ON ... WHERE tsCode = ANY($1) ORDER BY calcDate DESC` 会把每票 10 年历史全排序 + 依赖统计信息选计划 → 统计过期即全表扫，浏览器轮询时 load 飙 50+。**改法 = LATERAL 点查**：`unnest($1) CROSS JOIN LATERAL (WHERE tsCode=X ORDER BY calcDate DESC LIMIT 1)`，走主键倒序索引扫，O(log n)、不吃统计。EXPLAIN 判读标准 = `Index Scan Backward using <表>_pkey`，无 Seq Scan/Sort 即对。

- **ANALYZE 已自动化**：compute-rps.ts（每日写后）+ backfill-rps.ts（大回补后）都加 `ANALYZE rps_scores`（best-effort）。此前全靠手动，一忘就 stale（与 [[ten-year-data-scale]] 的 load 9 事故同源）。

相关：[[ten-year-data-scale]]、[[server-info]]
