---
name: fuyao-integration
description: 同花顺 fuyao API 接入全景——已接入接口、复权口径改造（daily_bars.adj_factor）与未切换的已知偏差、dump/历史K 的单位与时区硬坑
metadata:
  node_type: memory
  type: project
  modified: 2026-08-24T02:20:00.000Z
---

同花顺 fuyao API（`lib/fuyao.ts`，X-api-key 免费）。文档聚合可 `curl https://fuyao.aicubes.cn/llms-full.txt` 一次性拉全。

## 已接入

- **特色数据**：涨停池 / 连板天梯 / 热股榜 / 飙升榜 / 个股异动原因 / 基金资料与重仓。
- **龙虎榜** `dragon-tiger-list`：机构净买入 + 买卖家数、游资榜、人气排名、概念列表、涨停原因（比 tushare `top_list` 只有汇总额丰富）。消费方三处：`/api/tushare/stock-data` 聚合加 `dragonTiger` 字段（上榜才非 null）→ `tushareData.ts` 拼席位行（金额单位**元**，用 fmtYuan）；AI 对话工具 `get_dragon_tiger`（`lib/chat-tools.ts` defs/server + `services/chat/browser-tools.ts` browser **三镜像，输出格式须一致**）；路由 `/api/fuyao/dragon-tiger`。
- **前复权历史 K** `prices/historical`：`getHistoricalK(thscode,start,end,adjust)` 单票 10 年一次拉，`adjust=forward` 直接前复权。路由 `/api/fuyao/kline`，输出对齐 `/api/kline` 字段（volume 股→手）。
- **THS 指数体系**：`ths-index-list`（tag=cn_concept ≈390 概念 / industry=881 一级 + 884 二级）+ `constituents/ths-stock-list`。落库 `ths_index`/`ths_index_member`（`sync-ths-index.ts`，全量覆盖式刷新，周一挂 run-daily）；反查 `/api/ths/concepts?code=` → 详情页行业/概念 chips。**申万口径（sw_*，scanner 行业过滤）与 THS 口径并存未统一**。
- **基金**：`/api/fund/performance/nav`（单位净值 + adj_nav，折溢价 = 现价/unit_nav−1，注意 429 限流，nav 是 T-1）；`/api/meta/tickers/list` 的 asset_type 含 fund-etf/fund-lof = 权威 ETF 清单（替代前缀正则）。详见 [[etf-feature-notes]]。

## 复权口径（已落地）

- **问题**：`daily_bars` 存 tushare daily 未复权价，窗口涨幅/RPS/MA 跨除权日失真（10 送 10 = 假 −50%）；而前端 K 线是前复权（腾讯/新浪/东财）。
- **方案**：`daily_bars.adj_factor`（tushare adj_factor 按 trade_date 一次全市场，与 sync-daily 同模式合并 + `--backfill-adj` 回补）。**未走 fuyao 复权因子 dump**（事件流要自己算累计因子，tushare 直接给算好的）。
- **已切换的消费方**（后复权比率 = 真实收益，展示价仍用原始 close）：
  - `compute-rps.ts` / `backfill-rps.ts`：`ret=(c0×f0)/(cN×fN)−1`
  - scan route `recent` CTE：**前复权归一** `close×f/FIRST_VALUE(f)`（窗口末根 == 原始价，MA 与 latest_close 同尺度可展示）
  - `backtest-factors.ts`：装载 OHLC×f，收益基准改用复权
  - `/api/kline/batch`：窗口函数出前复权 K 线（价×adj_factor/最新因子）
- **未切换（已知偏差，短窗影响小）**：`chip.ts` 与 `candidates.ts` 数组（筹码峰价位与原始现价混比）、`compute-market-breadth`、replay 类 backfill、eval 回填、`optimize-params`、`explore-alert-rules`。
- **切换原则**：凡「与当前原始价比较的价位」必须用**前复权**（÷最新因子），不能用后复权。

## 硬坑（实测，2026-08-10）

- **单位换算**：dump/历史K 的 volume 是**股**（`daily_bars.vol` 是**手**，实测比值 100，写库须 /100）；turnover 是**元**（`daily_bars.amount` 是**千元**，实测 1000，须 /1000）；close 与 tushare 逐分相等（都原始价）；thscode 即 `600519.SH` 直接入库。
- **dump 没有 pre_close/change_pct**（也无换手率）→ **不能 `LAG(close)` 硬算**，除权日会假跌（茅台 2026-06 除息实证）。须用复权序列推导：`change_pct_t=(adj_t/adj_{t-1}−1)×100`，`pre_close_t=close_t×adj_{t-1}/adj_t`。
- **adj_factor 推导（实证成立）**：`adj_factor_t = qfq_t/raw_t × k`，k = 接缝日 tushare adj_factor（每只票一个恒定常量）。茅台 420 天窗口复现 tushare 因子，最大偏差 0.56%（除权舍入差异，非漂移）。**取 k 用重叠窗口的中位数**，别用单日。
- **`date_ms` 是 Asia/Shanghai 零点，必须用 timeZone 转换**（`toISOString` 会偏一天，踩过）。
- **dump 下载端点必须带 `/api` 前缀**（`/api/dump/market-dumps/<kind>/download-url`），返回 S3 预签名 URL（5 分钟有效），parquet GET 实测可下。10 年全市场日K + 复权因子全量 dump 是将来铺长历史库的备选。
- **历史换手率 THS 没有**（dump/历史K 均无 turnover 列）→ 深历史里 chip 只能走 `FIXED_DECAY=0.97` 降级（chip.ts:42）。要深历史 chip 才补 tushare `daily_basic`（约 2500 调用 / 40 分钟）。当前无消费方需要，可接受退化。
- fuyao 客户端**无内置限速**，脚本侧 `sleep 250ms` 自律；`lib/fuyao.ts` 已补 dotenv 加载（tsx 脚本不自动读 `.env.local`）。

## 未接入（评估过，别重复调研）

- fuyao 估值快照/财务指标与 tushare `daily_basic`/`fina_indicator` 重叠大（仅胜在盘中实时 + PCF）；全市场估值筛选应走 sync-daily 多落 pe_ttm/pb 列，未做。
- `/api/fund/market/historical`（ETF 日线）adjust 固定 null 不复权，只能当备用。
- `ths-index-membership`（个股反查所属指数）官方"敬请期待"，上线后可替代自建成分反查。
- tushare `adj_factor` 本项目 key **有权限**（按 trade_date 查全市场）。

相关：[[alert-rules-refactor-plan]]、[[etf-feature-notes]]、[[ten-year-data-scale]]
