---
name: share-feature
description: 分享功能(2026-08-13)：明文快照+分享码读凭证+ownerToken写鉴权；订阅制只读+多选移入；部署需 migrate-share.sql
metadata: 
  node_type: memory
  type: project
  originSessionId: 6a68bc91-270d-422b-a9bb-4f7877a94aac
  modified: 2026-08-17T06:41:05.874Z
---

自选分享功能（2026-08-13，订阅制+只读）。高手把分组分享给群友：分享方勾选分组生成 6 位分享码，订阅方输码只读查看、多选移入自己的自选。

**安全模型**：快照是明文（组名+标的，非敏感）→ 分享码=「读凭证」（GET 免鉴权，限流 30/min/IP 防遍历码空间）；ownerToken=「写凭证」（16B 随机 hex 只存分享方本地 store，POST 更新/DELETE 撤销校验，防他人篡改）。expiresAt null=长期，默认长期/7天/30天。

**快照结构**：`{ groups: [{ name, stocks: [{ code, name }] }] }`（v1；组名分享方防重名）。改结构无版本号，客户端 JSON.parse 容错即可（本地缓存，不跨版本兼容问题）。

**文件地图**：
- `prisma/schema.prisma` ShareSnapshot 模型 + `scripts/migrations/migrate-share.sql`（部署必跑，别 db push）
- `app/api/share/route.ts` — GET(拉取)/POST(创建随机码撞码重试 5 次/更新)/DELETE(幂等)；限流 POST/DELETE 10/min
- `store/share-store.ts` — 我的分享(shareCode/token/displayName/groupIds/mode/expireDays) + subscriptions(码+显示名+缓存快照) persist 'stock-share-store'
- `services/share/engine.ts` — enableShare/updateShare/disableShare/subscribeShare/refreshShare/packShareSnapshot/initShareAutoSync（auto 模式监听 stockStore debounce 15s，lastShareHash 防空传）
- `components/ShareModal.tsx` — 两 tab(分享/订阅)+只读详情三级视图；详情多选移入复用 addToWatchlist(stock, groupId)（已存在补组语义）
- `components/SyncEngine.tsx` — 挂 initShareAutoSync（全站）
- `app/page.tsx` — 首页「分享」按钮（Share2 icon，PageHeader actions，紧挨「同步」）

**关键决策**：订阅列表本地 persist 不进云同步 blob（换设备重输码）；**我的分享状态 08-17 起进 blob**（多设备接管同码）；撤销分享后订阅方保留最后一次快照（只读视图显示旧数据，08-17 起标 dead 灰显）；订阅方多选移入=一次性拷贝天然脱离订阅；不含 AI 配置/apiKey；文案不提"高手"。

**部署**：git push 后服务器 `npx prisma db execute --file=scripts/migrations/migrate-share.sql` → `npx prisma generate` → `npm run build` → `pm2 restart stock-analysis`。验证：双浏览器开分享→输码订阅→更新→移入。

**2026-08-17 扩展**：
- 订阅人数统计：`share_subscribers(code, subscriber_id)` 表（migrate-share-subscribers.sql，部署必跑）；订阅标识复用 sync-store 的 deviceId（全站挂载即生成，12 hex），subscribe/refresh 时作 `sid` 参数上报 upsert；退订走 DELETE /api/share {code, sid} 减员（engine.unsubscribeShare）→ 人数=当前订阅数；分享方 GET /api/share?code=&ownerToken= 返回 subscriberCount；ShareModal 分享码下方显示"X 人订阅"；撤销分享联动删订阅记录。只记人数不记身份。
- 性能（同次大修）：分享只读详情/自选页/首页预警全部切批量接口——`/api/quotes`（腾讯多代码 50/块+lib/server-quote-cache.ts 5s 缓存+在途去重+漏网单码三源兜底，/api/quote 单码也接入）、`/api/kline/batch`（daily_bars 窗口函数出前复权K线，口径=价×adj_factor/最新因子）；`/api/kline` 加 60s 缓存、`/api/chip` 加 30min 缓存、预警检查 chip 8 并发预取。根因：400+ 自选用户增多后逐只请求打爆 2 核服务器。

**2026-08-17 幽灵股票修复 + 多码治理**：
- 病因：分享自动上传订阅整个 stockStore（预警扫描 addAlerts 等高频写入也触发）→ 陈旧后台标签页/旧设备把过时分组发布到分享码（分享 API 无版本闸，后写必赢，不像同步有 baseVersion 409）→ 接收方看到「不存在的股票」，新鲜设备再传又「好了」
- 修复①触发收窄：仅 watchlist/groups 引用变化才调度；②先收敛再发布：自动上传前 checkAndPull() 对齐云端
- **分享状态进云同步 blob**（v3 软加 `data.share` 可选键不升版本，老客户端忽略未知键）：code/token/displayName/groupIds/mode/expireDays 全走 blob，新设备拉取即接管同一分享码，撤销随同步传播；useShareStore 纳入同步上传订阅
- 接收方 404 治理：refreshShare 遇 404 打 `dead` 标（upsert 成功自动复活），订阅列表灰字删除线「对方已撤销 · 显示最后快照」
- 体检脚本手法：prisma 客户端脚本 base64 传服务器跑（需用户授权），查快照 NAMELESS/SAME_TAIL 异常；孤儿码（token 丢失撤不掉）只能 SQL 删 `share_snapshots`

关联 [[watchlist-group-feature]]（多组映射结构是快照数据源）[[server-info]]（部署）[[sync-code-plan]]（同步与分享入口并列）
