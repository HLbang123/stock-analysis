---
name: ten-year-data-scale
description: 10年数据已是常态——任何新脚本/SQL必须按千万行级表设计；2026-08 多次 OOM/load 事故的军规清单
metadata: 
  node_type: memory
  type: project
  originSessionId: 0e343bce-a6bb-46b1-9d20-8182978e2173
  modified: 2026-08-17T08:20:29.433Z
---

**2026-08-15 起，本库是 10 年全量数据**。写任何脚本/查询前，先按这个量级估算：

- `daily_bars` ≈ **1080 万行**（2016-05 起，5796 只 × 2495 交易日）
- `rps_scores` ≈ **1035 万行**（2350 天 × ~5500 只）
- `alert_rule_triggers` 30 万+ 行，持续增长
- 服务器只有 **2 核 / 3.8GB**（详见 [[server-info]]）

## 军规（每条都对应一次真实事故）

1. **SQL 必须带日期边界**。禁止「拉全历史再 JS 处理」——`/api/rps/batch`（拉每票全量 RPS 再取最新，12万行/请求，load 9 事故）和 `/api/kline/batch`（窗口函数读每票全历史）都是这个死法。线上接口每请求 >1 万行就要警惕。
2. **内存估算先行**：行数 × 字段数 × ~40B。全市场 10 年日线进 JS 数组 ≈ 2.8GB 峰值 → 默认 2GB 堆必 OOM，大脚本一律 `NODE_OPTIONS="--max-old-space-size=3584"`。能预分配 Float64Array 就别用 JS 数组累积。
3. **窗口函数必须有候选集 + 日期双边界**（scan 的 cand CTE + startDate 是正确范本）。
4. **`DISTINCT tradeDate/calcDate` 必须配 LIMIT**——10 年=2495 个日期，无 LIMIT 全表扫。
5. **大批量写入后第一件事 ANALYZE**（rps_scores/daily_bars 已设 autovacuum_analyze_scale_factor=0.01，但手动大批量回补后仍要立即手动刷——统计过期会让按码查询退化成并行全表扫）。
6. **跑法三铁律**：`setsid`（nohup 护不住 npx 子进程）、3584 堆、`&&` 串行链。细节见 [[server-info]]。
7. **新脚本先小窗口试跑**（--days=60 验证逻辑与内存），再放全量。
8. **build/部署与批处理永不同时**——2 核机器，撞一起就是双输。

## 反面教材（2026-08 事故清单）

- backfill-rps OOM → 滑窗释放缓存修复
- backtest-factors OOM ×2 → 3584 堆 + setsid
- compute-market-breadth/compute-rps 卡死 → 统计过期，ANALYZE 治
- 全站白天 load 9 → rps/batch 无日期过滤 × 12 并发 × 统计过期
