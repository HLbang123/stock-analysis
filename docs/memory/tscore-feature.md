---
name: tscore-feature
description: 波段评分功能(原心姐快速分析重做)— 买点/卖点双信号分(因子确定分+LLM±15微调)，仅自选标的，买卖点恒算恒显；做T规则=8买+8卖因子(2026-08-03优化: 复合因子「底部低吸/冲高衰竭」+15分RSI/MACD水上下叉+趋势门控+尾盘打折)，改规则在 scorer.ts(因子+权重+curve)与 intraday.ts(派生量)
metadata:
  node_type: memory
  type: project
  originSessionId: 9710d063-067f-471c-a49a-1783412957ae
  modified: 2026-08-07T07:06:32.217Z
---

2026-07-30 把「心姐分析」快速档完全重做为「波段评分」。对外文案一律「波段评分」，禁"做T/股"字眼(见 [[naming-compliance]])。深度分析里的心姐辩手(deepAnalysisPrompt.ts 的 buildXinJieR1/R2)**保留不动**，只删了 services/xinjiePrompt.ts。用户后续主要优化**做T规则(=因子)**。

## 文件结构(下次改这几处)
- `services/t-score/intraday.ts` — `buildIntradayContext(minute): IntradayContext`。纯函数，自算累计 VWAP；2026-07-30 加 `aggregateMinuteBars(pts,N)`(1分→5/15分K,时钟floor分组,兼容m5回退;high/low为组内收盘价极值近似) 产出 `m5VolSurgeRatio`/`m5LastUp`/`m15SupportDistPct`。产出的派生量是所有分时因子的输入(见下)。
- `services/t-score/scorer.ts` — **做T规则核心**。`DEFAULT_TSCORE_PROFILE`(curve 参数) + `BUY_WEIGHTS`/`SELL_WEIGHTS`(权重) + 14 个因子函数 + `computeTScore(input): TScoreResult`。改规则就改这里。
- `services/t-score/prompt.ts` — `buildTscoreSystemPrompt(isETF)`(含合规禁令) + `buildTscoreUserPrompt(input)`。LLM 输出 JSON schema 也定在这。
- `app/api/ai/t-score/route.ts` — 非流式 LLM 代理 + `parseJsonLenient` + coverage≥0.6 门控+1重试 + 有界融合 + 合规 regex 后处理。镜像 ai-screen ranker。
- `components/ai/TScorePanel.tsx` — 结果 UI，导出 `TScorePanelResult` 类型(page 复用)。2026-08-07 起「因子分解」卡默认折叠（用户反馈多数人看不懂），点标题行展开。
- `app/ai/page.tsx` — `runTScore`(原 runAnalysis 位)、按钮、结果区挂 `<TScorePanel/>`。
- `store/ai-store.ts` — `AiAnalysisRecord` 加了 buyScore/sellScore/buyAdjust/sellAdjust/buyReason/sellReason/analysis/buyFactorsJson/sellFactorsJson/intradayJson/llmAdjusted 可选字段(兼容旧记录)。

## 数据流
客户端 `runTScore`：拉 `getRealtimeQuote` + `getKLineSina(240,120)` + `getMinuteDataCached` + `getChipData` → `checkAllRules`(alertRules) → `calculateIndicators`(日级,lib/indicators) → `buildIntradayContext`(分时) → 闭市/分时<10 则 degraded 返回 → `computeTScore`(确定性分,先 setResult 让因子分秒出) → `buildTscore*Prompt` → POST `/api/ai/t-score` → 合并 LLM 微调 → setResult + addHistory。

## 做T规则 = 因子(scorer.ts，改这里)
**分时派生量**(intraday.ts 产出，分时因子读这些)：`vwap`/`vwapDevPct`(偏离VWAP%) / `rangePosPct`(日内位置0-100) / `mom15`(近15分回归斜率bps/分,负=回调) / `downVolRatio`(近30分下跌量占比) / `last5VolRatio`(近5分均量/全日) / `high`/`low`/`last`/`open` / `granularity`('m1'|'m5',m5=5分K回退低保真) / `sufficient`(count≥10) / `m5VolSurgeRatio`(最新5分K量/前均量,0=不足) / `m5LastUp`(最新5分K收>前根) / `m15SupportDistPct`(最新15分收高于前期15分低点的%,null=不足,负=跌破)。
**2026-08-03 做T增强派生量**(intraday.ts，5/15分K聚合后算)：`rsi6`/`rsi12`(15分K Wilder RSI) / `rsiBullDivergence`/`rsiBearDivergence`(15分K价-RSI顶底背离,fractal pivot) / `macdDiff`/`macdDea`/`macdHist`/`macdHistPrev`/`macdAboveZero`/`macdCrossUp`/`macdCrossDown`(5分K MACD12/26/9,5分K<30根=null) / `mHead`/`mHeadConf`(盘中M头:二次冲高未过前高±0.3%+红柱缩短) / `m5UpVolRatio`/`m5UpShrink`(最近上涨5分K量比,<1=缩量冲高) / `m5Faded`(最新5分K上影>实体1.5倍=冲高回落) / `m15SupportHeld`(15分支撑近期探底0.5%内不破+当前收回) / `minuteOfDay`(当前分钟数,尾盘≥870)。

**买入8因子**(`BUY_WEIGHTS`)：回踩VWAP(.15) / 日内低位(.12) / 缩量回踩(.12) / 分时动量(.10) / 日级趋势(.11) / 无卖出信号(.10) / **底部低吸(.20,做T复合)** / 15分MACD水下金叉(.10)。
**卖出8因子**(`SELL_WEIGHTS`,恒算)：高于VWAP(.15) / 日内高位(.12) / 放量上涨(.12) / 分时动量(.10) / 日级过热(.11) / 卖出信号触发(.10) / **冲高衰竭(.20,做T复合)** / 15分MACD水上死叉(.10)。
- **做T复合因子**(scorer.ts `buyBottomDip`/`sellSellOff`，避免 4-5 个高度相关信号重复加权)：买=回踩支撑(0.5)+RSI超卖(0.35)+底背离(0.15)，子函数 `buyM15Support`/`buyRsiOversold`/`buyRsiBullDivergence`；卖=5分冲高(0.4)+RSI超买(0.3)+M头(0.2)+顶背离(0.1)，子函数 `sellM5VolSurge`/`sellRsiOverbought`/`sellMHead`/`sellRsiBearDivergence`。尾盘打折只在复合层做一次。子因子不再单独列面板。
- 2026-07-30 加做T两因子(权重0.08低权重,用户规则未定稿暂行)：买`buyM15Support`(15分K收盘贴近前期15分低点→低吸;curve `buy_m15_slope=20`/`buy_m15_breakdown=25`)、卖`sellM5VolSurge`(最新5分K放量且收阳→高抛;curve `sell_m5_base=45`/`sell_m5_surge_slope=30`)。数据不足(5/15分K<4根)取中性50。为腾权重：买vwap.22→.18+日级趋势.20→.16；卖vwap.22→.18+日级过热.20→.16。
- 各因子是独立函数(如 `buyPullbackToVwap(ctx,p)`)，返回 clip(0,100)。curve 参数全在 `DEFAULT_TSCORE_PROFILE`(键名 `buy_*`/`sell_*`，如 `buy_vwap_ideal=-0.4`/`buy_vwap_slope=14`/`buy_range_chase_start=75`/`sell_vwap_overext_start=3.5` 等)。
- 加因子：写函数 + 在 buyFactors/sellFactors 数组加一项(带 name/score/weight) + 权重自动归一(Σ weight 归一,无需手改)。
- 调阈值：直接改 `DEFAULT_TSCORE_PROFILE` 对应键。日级因子用本地 helper(macdStatus/maBullish/pullbackToMa20Pct/breakout20dPct/rsiStatus,在 scorer.ts 顶部,用 lib/indicators 的 calculateMA/EMA/calcRSISeries)。
- **2026-08-03 做T优化**(源自群教学记录 RSI/MACD 做T流派)：新增 15分RSI超买超卖(RSI6>80高抛/<20低吸,升/降势钝化门控 cap) / 15分MACD水上下叉(水上死叉卖/水下金叉买) / 盘中M头(二次冲高未过前高+红柱缩短) / 5分冲高(放量/缩量/回落) / RSI顶底背离(fractal pivot,升势信底背离/降势信顶背离)。**趋势调制器** `dailyTrend(closes)`(MA+MACD判 up/down/sideways) 决定 RSI超买超卖与背离因子可信度；**尾盘** `minuteOfDay≥870(14:30)` 对均值回归信号打折(×0.6)。**RSI金叉死叉是噪声,特意没做**(15分触发太频繁)。**注意 MACD 用5分K**(15分K单日仅16根算不出 MACD;5分K 48根可算,但早盘<30根=null→因子中性)。
- 信号类因子读 `engineResults`(alertRules) + `SELL_RULE_IDS` + `CRITICAL_SELL_IDS={R01,R02,R04}`(2026-08-03 预警规则重排后,原 R02/R04/R08)。

## LLM 微调契约
- prompt 要求 LLM 只返回 JSON：`{buy_adjust, sell_adjust, buy_reason, sell_reason, analysis(≤180字综合说明), confidence, tags}`，调整量 ±15 内整数。
- 融合：`finalBuy=clamp(buyScore+buy_adjust[-15,15],0,100)`，卖同。失败回退纯因子分(llmAdjusted=false)。
- 合规后处理(路由)：regex 股→标的/做T→波段/推荐建议→信号参考。

## 关键约束/坑
- **日内30/60分K拿不到**：/api/kline 腾讯/东财写死日线挡新浪，只能用 1 分钟分时(/api/minute 腾讯)。做T规则基于 1 分时 + 日K；5/15分K 由 `aggregateMinuteBars` 从1分时聚合(close-based OHLC近似,无历史只有当日)。60分K需历史→只能Tushare `stk_mins`(限频1/分钟,实测撞过1/小时,盘中实时不可行,未启用)。
- **/api/minute 内存缓存**(2026-07-30加)：route.ts 内 8s TTL + 在途请求去重(`minuteCache`/`minuteInflight`)+拉空降级,治自选页并发突发。腾讯 fqkline 只支持日线(m5/m15 bad params),方案2 m5回退是死分支；方案1 minute/query 须 https(http 302)。
- **分时 avgPrice 是 price 副本(bug)**：必须自算 VWAP，永不读 avgPrice。
- **不要 import ai-screen/indicators**：它 runtime import lib/chip→prisma，会污染客户端 bundle(net/tls/fs 报错)。日级 helper 在 scorer.ts 本地实现。
- **买卖点恒算恒显**：仓位(positionPercent)仅作 LLM 上下文，不作算/显卖点的门槛(很多人不填仓位但有持仓)。
- **degraded**：分时 count<10 或市场非交易时段(`fetchMarketStatusNote().includes('交易中')`为 false)→ 不算分不调 LLM，显降级横幅。盘中工具本质，非 bug。
- 本地调试：本地无 Postgres(见 [[server-info]])，/api/chip(筹码)会 500→chip=null 因子降级不崩；行情/分时/K线走新浪腾讯代理不依赖 DB 可跑；扫描器/AI筛选走 DB 本地 500。

## 待办(数据依赖，攒2-3周再说)
- 因子 curve 参数与权重是初始占位，等 T+N 攒够后按 IC 迭代(用户下次主要做这个)。
- 完整 T+N 回路(类 [[ai-screen-feature]] 的 AiScreenEval+每日回填)延后；v1 历史已存 buyScore/sellScore/finalBuy/adjust/因子分解/intradayJson/时间戳到 ai-store(localStorage)，回测需日内出场数据。
- LLM ±15 微调幅度合理性等样本多了评估。
