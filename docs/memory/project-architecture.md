---
name: project-architecture
description: 项目目录结构地图——页面/API/数据源/DB/服务/store/脚本/鉴权一览，新对话免重新探索
metadata: 
  node_type: memory
  type: project
  modified: 2026-08-12T10:24:58.225Z
  originSessionId: 649e24ea-2761-4d87-ad63-9642860a8d53
---

A股形态预警系统。技术栈：**Next.js 16.2.10 + React 19.2.4 + Prisma 7.8（@prisma/adapter-pg）+ PostgreSQL + Zustand 5 + Tailwind 4 + ECharts/lightweight-charts**。
注意：这是改造版 Next.js（见 AGENTS.md），读 `node_modules/next/dist/docs/` 再写代码。**middleware 已被 `proxy.ts` 取代**（Next 16 把 middleware 改名 proxy）。

**代码定位用 CodeGraph**（2026-08-12 引入，详见 [[codegraph-tooling]]）：项目已建索引（.codegraph/，自动增量同步），定位符号/影响面优先 `codegraph explore/query/impact`，别先 grep 全仓。本文档只管业务语义与结构总览，不再承担"找代码在哪"的职责。

## 鉴权（root `proxy.ts` + `lib/auth.ts`）
- `proxy.ts` = 全局网关（原 middleware.ts，已删）。公开路径仅 `/login`、`/api/auth`；其余无 token → API 返 401、页面跳 `/login`。matcher 排除静态资源。
- `lib/auth.ts`：`AUTH_COOKIE` + `verifyToken`，cookie 鉴权（口令登录，非 OAuth）。
- 登录兜底已部署（渐进增强：原生 form 提交 + `mounted` 控制按钮，hydrate 失败也能过登录关）。

## 页面（app/）
- `app/page.tsx` — 首页=预警页。自选股 watchlist，逐股 fetch 行情+K线→`checkAllRules`→写 store。买入信号同日≥2条聚合成"买入共振"块 [[alert-rules-refactor-plan]]。
- `app/scanner/page.tsx` — 全市场扫描。状态在 `store/scanner-store.ts`（持久化 v6，含板块过滤+RSI过滤），调 `/api/scan`。
- `app/ai/page.tsx` — AI 对话 + 深度分析 + AI筛选（同页切换）。AI筛选走 `services/ai-screen/` [[ai-screen-feature]]，对外称「AI筛选」[[naming-compliance]]。
- `app/market/page.tsx` — 大盘页。市场宽度/涨停情绪/行业资金/热度/估值/融资融券/北向。
- `app/stock/[code]/page.tsx` — 个股详情。K线+分时图标记（按 ruleId 定位最高/最低价）+触发规则+历史预警。
- `app/watchlist/page.tsx` — 自选股管理。`app/ocr/page.tsx` — OCR（tesseract.js）。`app/login/page.tsx`、`app/health/page.tsx` — 登录页、健康检查。

## API（app/api/，全部 route.ts）
- `scan/route.ts` — **raw SQL**（`$queryRawUnsafe`，非 Prisma 模型）。CTE 链算 MA/金叉/VCP，RPS/金叉/55日线/ROE/VCP/板块 AND 组合过滤。
- `ai-screen/route.ts`(+`[runId]/`) — AI筛选跑/历史/详情。
- `ai/` — `chat`(SSE流+15s心跳保活)、`deep-analyze`(深度分析，同样心跳)、`analyze`、`models`、`test`。
- `market/` — `breadth`、`index-valuation`、`margin`、`northbound`、`sector-flow`、`sector-index`。
- `fuyao/` — `anomaly`/`fund`/`hot-stocks`/`limit-up`（同花顺 fuyao，日级快照）。
- `limit-up/route.ts` — Tushare `limit_list_d`，**EOD**（取 daily_bars 最新交易日），盘中不能用。
- `industries`、`sectors`、`sector-stocks`、`rps`(+`sectors`)、`stock/rps`、`kline`、`minute`、`quote`、`search`、`market-status`、`ocr`、`tushare/stock-data`、`auth`。

## 数据源（lib/）
- `lib/data-sources/` — 三源 fallback 结构化：`kline/{eastmoney,sina,tencent}.ts` + `quote/{eastmoney,sina,tencent}.ts` + `registry.ts`（选源/降级）。
- `lib/tushare.ts` — Tushare 高级接口（涨跌停/行业/资金流/北向/融资融券）。`lib/fuyao.ts` — 同花顺 fuyao（key=FUYAO_API_KEY）。`lib/identify.ts` — ts_code→交易所。
- `lib/llm/` + `lib/llm-client.ts` + `lib/llm-stream.ts` — LLM 客户端/SSE 流。`lib/sectors.ts`、`lib/stock-helpers.ts`、`lib/indicators.ts`(RSI/MA 单一事实源)、`lib/cache.ts`、`lib/constants.ts`、`lib/auth.ts`、`lib/chat-tools.ts`、`lib/ai-error.ts`、`lib/api-helpers.ts`。

## DB（prisma/schema.prisma，lib/db.ts PrismaPg adapter）
14 个模型：`Stock`、`DailyBar`、`RpsScore`、`MarketBreadth`、`IndexValuation`、`NorthboundFlow`、`MarginTotal`、`StockFundamental`、`StockMoneyflow`、`SwIndexDaily`、`SwIndexMember`、`AiScreenRun`、`AiScreenPick`。
**列名陷阱**：只有标 `@map` 的字段在 DB 是 snake_case；`DailyBar` 的 `tsCode`/`tradeDate`、`RpsScore` 的 `tsCode`/`calcDate` 是 camelCase（raw SQL 要带双引号如 `"tsCode"`）。写 raw SQL 前查 schema.prisma 确认。`daily_bars` 孤儿会卡 `prisma db push`——AI筛选表已 raw SQL 建表绕过，部署别跑 db push。
默认 DATABASE_URL=localhost:5432，生产在硅云 CVM（见部署节）。`.env.local` 是 dotenvx 加密。

## 服务（services/）
- `alertRules.ts` — 12 条预警规则 [[alert-rules-refactor-plan]]。`deepAnalysisPrompt.ts` — AI prompt 注入源（RULES_TABLE）。`aiPrompt.ts`/`xinjiePrompt.ts`/`tushareData.ts` — 其他 prompt/数据组装。
- `stockApi.ts` — 新浪实时行情+K线（调 data-sources）。`ai-screen/` — `candidates`/`engine`/`indicators`/`scorer`/`ranker`/`prompt`/`risk`/`strategies`/`types` [[ai-screen-feature]]。

## Store（Zustand + persist，localStorage）
`store/index.ts`(alerts/watchlist/rules，去重键 `stockCode-ruleId`，上限500)、`scanner-store.ts`(扫描 v5)、`ai-store.ts`、`ai-screen-store.ts`。

## 组件（components/）
`ai/`(AiChat/AiScreenPanel/AnalysisHistory/ProfileFormModal/ProfileSettingsModal/ReasoningPanel/shared)、`layout/`(shell/sidebar-nav/bottom-nav)、`market/`(EChart)、`ui/`(badge/button/card/spinner)、`providers/`(theme-provider)。根 `components/`：KLineChart、MinuteChart、UpdateLog。

## 脚本（scripts/，`npx tsx scripts/xxx.ts`）
数据同步：`sync-daily`(日线)、`sync-stocks`、`sync-fundamentals`、`sync-hsgt`(北向)、`sync-margin`、`sync-moneyflow`、`sync-index-valuation`、`sync-sw-daily`/`sync-sw-member`(申万)。计算：`compute-rps`、`compute-market-breadth`。调度：`run-daily`(全量日任务)。`fetch-stocks.js`。

## 部署/网络
硅云香港 CVM `103.151.217.28`，nginx(80+443)→Next:3000(PM2 进程名 `stock-analysis`)，域名 xkls888.top。部署只需 `git pull && npm run build && pm2 restart`（别跑 `prisma db push`，孤儿会卡）。服务器详情见 [[server-info]]，用户 git 推送习惯见 [[user-git-habits]]。
