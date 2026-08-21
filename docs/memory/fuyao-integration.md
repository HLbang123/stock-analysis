---
name: fuyao-integration
description: 同花顺fuyao API接入全景——已用/未用接口、实测结论(含dump鉴权坑)、复权口径改造与待执行的服务器步骤
metadata: 
  node_type: memory
  type: project
  originSessionId: 9f9f9778-8b6a-4871-92bb-b0ab7836e0f6
  modified: 2026-08-10T08:58:17.698Z
---

同花顺 fuyao API（`lib/fuyao.ts`，X-api-key 免费）接入全景。文档聚合可 `curl https://fuyao.aicubes.cn/llms-full.txt` 一次性拉全。

## 已接入（2026-08-10 扩展后）

- **特色数据**（早前已用）：涨停池/连板天梯/热股榜/飙升榜/个股异动原因/基金资料与重仓。
- **龙虎榜** `dragon-tiger-list`（W1）：机构净买入+买卖家数、游资榜（游资名+个股净买）、人气排名、概念列表、涨停原因——比 tushare top_list（仅汇总额）丰富。消费方：①`/api/tushare/stock-data` 聚合加 `dragonTiger` 字段（上榜才非 null）→ `tushareData.ts` 龙虎榜段拼席位行（金额单位**元**，用 fmtYuan）；②AI 对话工具 `get_dragon_tiger`（defs/server `lib/chat-tools.ts`/browser `services/chat/browser-tools.ts` 三镜像，输出格式两版须一致）；③路由 `/api/fuyao/dragon-tiger`（board/date/code 参数，code 支持 6 位自动补后缀）。
- **前复权历史K** `prices/historical`（W2）：`getHistoricalK(thscode,start,end,adjust)` 单票10年一次拉，adjust=forward 直接前复权。路由 `/api/fuyao/kline?code=&days=&adjust=`，输出对齐 /api/kline 字段（volume 股→手）。
- **THS 指数体系**（W4）：`ths-index-list`(tag=cn_concept≈390概念/industry=881一级+884二级) + `constituents/ths-stock-list`(成分)。落库 `ths_index`/`ths_index_member`（sync-ths-index.ts，全量覆盖式刷新，周一挂 run-daily）；反查 `/api/ths/concepts?code=` → 详情页行业/概念标签 chips。申万口径(sw_*,scanner行业过滤)与THS口径并存未统一。

## 复权口径改造（W3，核心）

- **问题**：daily_bars 是 tushare daily 未复权价，窗口涨幅/RPS/MA 跨除权日失真（10送10=假-50%）；前端看板 K 线却是前复权（腾讯/新浪/东财）。
- **方案**：daily_bars 加 `adj_factor` 列（tushare adj_factor 按 trade_date 一次全市场，与 sync-daily 同模式合并+`--backfill-adj` 回补）。**未走 fuyao 复权因子 dump**（事件流需自己算累计因子，tushare 直接给算好的）。
- **消费方切换**（后复权比率=真实收益，展示价仍用原始 close）：
  - compute-rps.ts / backfill-rps.ts：`ret=(c0×f0)/(cN×fN)−1`，findMany select adjFactor 后 JS 乘。
  - scan route `recent` CTE：**前复权归一** `close×f/FIRST_VALUE(f)`（窗口末根==原始价，MA 与 latest_close 同尺度可展示）。
  - backtest-factors.ts：装载 OHLC×f（内部自洽），收益基准从 row.close(原始) 改 stock.close[li](复权)。
  - **未切（已知偏差）**：chip.ts 与 candidates.ts 数组（筹码峰价位与原始现价混比，短窗影响小）、compute-market-breadth、replay 类 backfill、eval 回填、optimize-params/explore-alert-rules。要切时注意：凡"与当前原始价比较的价位"必须用前复权（÷最新因子）不能后复权。
- **服务器待执行**（本地无 DATABASE_URL）：①跑 `scripts/migrations/migrate-adj-factor.sql` + `migrate-ths-index.sql`；②`npx prisma generate`；③`npx tsx scripts/sync-daily.ts --backfill-adj`（约600次调用）；④重跑 compute-rps + backfill-rps --days=80；⑤`npx tsx scripts/sync-ths-index.ts` 首刷。

## 实测结论（2026-08-10 验证）

- **10年 dump 填库的对齐口径（2026-08-10 实证）**：
  - dump/历史K 的 volume 是**股**（daily_bars.vol 是**手**，实测 fuyao/tushare=100，写库须 /100）；turnover 是**元**（daily_bars.amount 是**千元**，实测=1000，须 /1000）；close 与 tushare 逐分相等（都原始价）；thscode 即 `600519.SH` 直接入库。
  - dump **没有** pre_close/change_pct（也无换手率）——不能 LAG(close) 硬算，除权日会假跌（茅台 2026-06 除息实证）；须用复权序列推导：`change_pct_t=(adj_t/adj_{t-1}−1)×100`，`pre_close_t=close_t×adj_{t-1}/adj_t`。
  - **adj_factor 推导（实证成立）**：`adj_factor_t = qfq_t/raw_t × k`，k=接缝日 tushare adj_factor（恒等常量，每只票一个 k）。茅台 420 天窗口 qfq/raw×k 复现 tushare 因子，最大偏差 0.56%（fuyao vs tushare 除权舍入差异，非漂移）。取 k 建议用重叠窗口的中位数而非单日。
  - date_ms 是 Asia/Shanghai 零点，**必须用 timeZone 转换**（toISOString 会偏一天，踩过）。
- dump 下载端点**必须带 `/api` 前缀**（`/api/dump/market-dumps/<kind>/download-url`，文档按钮走 cookie 但 API key 同样可用），返回 S3 预签名 URL（5 分钟有效），parquet GET 实测可下。10年全市场日K+复权因子全量 dump 是将来铺长历史库的备选。
- **历史换手率 THS 没有**（dump/历史K 均无 turnover 列）→ 10y 深历史里 chip 只能走 FIXED_DECAY=0.97 降级（chip.ts:42）；如未来深历史回测需要 chip，才补 tushare daily_basic（2500 调用~40分钟）。当前无消费方需要深历史换手率，可先接受退化。
- tushare adj_factor 本项目 key **有权限**（按 trade_date 查全市场）。
- fuyao 估值快照/财务指标与 tushare daily_basic/fina_indicator 重叠大，**未接入**（估值快照仅胜在盘中实时+PCF；全市场估值筛选应走 sync-daily 多落 pe_ttm/pb 列，未做）。
- fuyao 客户端无内置限速，脚本侧 sleep 250ms 自律；`lib/fuyao.ts` 已补 dotenv 加载（tsx 脚本不自动读 .env.local）。
- ths-index-membership（个股反查所属指数）官方"敬请期待"，上线后可替代自建成分反查。

相关记忆：[[alert-rules-refactor-plan]]、[[project-architecture]]
