---
name: ten-year-data-scale
description: 十年数据军规——库是 10 年全量，任何脚本/SQL 按千万行级设计；含消费地图（App 只需 4 年）、DISTINCT ON→LATERAL 改法、2026-08 OOM/load 事故清单
metadata:
  node_type: memory
  type: project
  modified: 2026-08-24T01:52:00.000Z
---

**2026-08-15 起，本库是 10 年全量数据**。写任何脚本/查询前，先按这个量级估算：

- `daily_bars` ≈ **1080 万行**（2016-05 起，5796 只 × 2495 交易日）
- `rps_scores` ≈ **1035 万行**（2350 天 × ~5500 只）
- `alert_rule_triggers` 30 万+ 行，持续增长
- 服务器只有 **2 核 / 3.8GB**（详见 [[server-info]]）

## 军规（每条都对应一次真实事故）

1. **SQL 必须带日期边界**。禁止「拉全历史再 JS 处理」——`/api/rps/batch`（拉每票全量 RPS 再取最新，12 万行/请求，load 9 事故）和 `/api/kline/batch`（窗口函数读每票全历史）都是这个死法。线上接口每请求 >1 万行就要警惕。
2. **内存估算先行**：行数 × 字段数 × ~40B。全市场 10 年日线进 JS 数组 ≈ 2.8GB 峰值 → 默认 2GB 堆必 OOM，大脚本一律 `NODE_OPTIONS="--max-old-space-size=3584"`。能预分配 Float64Array 就别用 JS 数组累积。
3. **窗口函数必须有候选集 + 日期双边界**（scan 的 cand CTE + startDate 是正确范本）。
4. **`DISTINCT tradeDate/calcDate` 必须配 LIMIT**——10 年 = 2495 个日期，无 LIMIT 全表扫。
5. **大批量写入后第一件事 ANALYZE**（rps_scores/daily_bars 已设 autovacuum_analyze_scale_factor=0.01，但手动大批量回补后仍要立即手动刷——统计过期会让按码查询退化成并行全表扫）。
6. **跑法三铁律**：`setsid`（nohup 护不住 npx 子进程）、3584 堆、`&&` 串行链。细节见 [[server-info]]。
7. **新脚本先小窗口试跑**（--days=60 验证逻辑与内存），再放全量。
8. **build/部署与批处理永不同时**——2 核机器，撞一起就是双输。

## 消费地图：别为 10 年数据过度设计

2026-08-19 load 尖峰排查结论（已修复落地）：

- **App 实时查询最多 ~4 年**：日 K 线图 `/api/kline/db` MAX_DAYS=1000 天，其余指标 ≤250 天，RPS/扫描取最新。真正扫 10 年的只有**回测**（月级离线）和**批量任务**（compute-rps / backfill / market-breadth，离线）。AI 对话工具（get_stock_rps / get_stock_history / get_chip_distribution）早已是点查或带日期边界。
- → **分区迁移评估后取消**。别再提"要不要分区"。

## DISTINCT ON + ANY 是大表雷（排查模式）

`SELECT DISTINCT ON ... WHERE tsCode = ANY($1) ORDER BY calcDate DESC` 会把每票 10 年历史全排序 + 依赖统计信息选计划 → 统计一过期就全表扫，浏览器轮询时 load 飙 50+。

**改法 = LATERAL 点查**：`unnest($1) CROSS JOIN LATERAL (WHERE tsCode=X ORDER BY calcDate DESC LIMIT 1)`，走主键倒序索引扫，O(log n)、不吃统计。
**EXPLAIN 判读标准** = `Index Scan Backward using <表>_pkey`，无 Seq Scan / Sort 即对。

## ANALYZE 已自动化

`compute-rps.ts`（每日写后）+ `backfill-rps.ts`（大回补后）都已加 `ANALYZE rps_scores`（best-effort）。此前全靠手动，一忘就 stale（与下方 load 9 事故同源）。**新写的大批量写入脚本请照此加上。**

## 反面教材（2026-08 事故清单）

- backfill-rps OOM → 滑窗释放缓存修复
- backtest-factors OOM ×2 → 3584 堆 + setsid
- compute-market-breadth / compute-rps 卡死 → 统计过期，ANALYZE 治
- 全站白天 load 9 → rps/batch 无日期过滤 × 12 并发 × 统计过期
- 2026-08-19 load 尖峰 → DISTINCT ON + ANY 撞统计过期（见上）

相关：[[server-info]]
