---
name: sync-code-plan
description: 云同步已实现待部署(2026-08-07)——配对码方案(6位短码+零知识加密快照+L2自动同步)；文件地图；部署需 migrate-sync.sql+generate+build
metadata: 
  node_type: memory
  type: project
  originSessionId: 3d2ddbf8-bb61-420a-a94a-0e470c388de8
  modified: 2026-08-17T06:41:47.898Z
---

2026-08-07 定稿并实现（本地 build 已过，未部署）。解决"换设备丢数据"（~300用户，群友最高频抱怨）。服务器压力测算可忽略（轻接口+偶发小blob，gzip必须在加密前）。

**架构（微信输入法式配对码，无16位长期码）**：
- 首台设备「开启云同步」零摩擦：生成 syncId(uuid)+syncKey(32B) 直接上传，无码可见
- 加设备：旧设备「添加设备」出 6 位数字码（10分钟TTL、一次性、IP限流10/min）→ 新设备输入取回 syncKey
- 零知识：syncKey 只在设备上；服务器存密文 blob + keyHash(写删鉴权)；apiKey 随快照加密同步
- 同步内容：自选+分组+持仓、AI profiles含key+currentProfileId、分析历史(≤100)。不同步：alerts/对话/scanner/规则(store rules是死代码)
- L2 自动同步默认开：改动 debounce 15s 上传 + 可见时 60s 版本轮询；409=LWW远端赢+toast
- 回调回声抑制：applyRemoteBlob 期间 applyingRemote 标记跳过上传（防互拉死循环）
- 唯一设备全丢=数据无法恢复（零知识固有代价，用户接受）；用户明确不要"预警需重检"提示、不要二维码、弹窗无表情无确认按钮
- **2026-08-12 设备清单**：blob v1→v2 加 `data.devices:[{id,name,lastSyncedAt}]`（共享随快照同步，零服务器改动）；store 持久化本机 deviceId(6B随机hex,clearIdentity不清但清devices)+deviceName(UA默认名:微信内置浏览器/平台+浏览器)；packSnapshot upsert本机+回写store，applyRemoteBlob远端为主但本机永远可见、共享清单为名字事实源(被它端改名本地跟随)；redeem后 upload(true)注册让原设备立见新设备；renameDevice/removeDevice(任意端改任意设备名/移除；移除=摘清单条目+自愈语义,被移除设备下次同步重新注册,本机不可移除;零知识下无法服务器踢出)；hash净化(packedAt+lastSyncedAt归零)防空传；SyncModal已开启态加清单(本机置顶角标/最近同步相对时间/点名字行内改名/行尾移除/刷新按钮)

**文件地图**：
- `lib/sync-crypto.ts` — 纯 Web Crypto：身份生成/gzip(特性检测,z:false降级)/AES-GCM信封/配对码PBKDF2(200k)包裹；**toBuffer 助手处理 TS5.7 typed-array 泛型**（BufferSource 参数必须 Uint8Array<ArrayBuffer>）
- `store/sync-store.ts` — 身份+autoSync+lastVersion+lastError+bannerDismissed（persist 'stock-sync-store'）
- `services/sync/engine.ts` — enableCloud/redeemPairCode/createPairCode/disableCloud/upload/pull/checkAndPull/initSyncEngine；内容hash防空传；409→pull+toast
- `app/api/sync/route.ts` — GET(pull/versionOnly轮询)/POST(409冲突)/DELETE(连带删配对)；blob≤1.5MB
- `app/api/sync/pair/route.ts` — POST建配对(同syncId旧行先删)/GET一次性取回即焚；`lib/rate-limit.ts` 内存限流(PM2单进程够用)
- `components/SyncModal.tsx` — 三态(未开启[开启+输入配对码并列]/配对码展示+倒计时/已开启[自动同步开关+添加设备+立即同步+关闭])
- `components/SyncEngine.tsx` — 挂 shell.tsx 全站生效
- `app/page.tsx` — 首页「同步」按钮(规则说明挪进汉堡菜单 UpdateLog 加 onShowRules prop)+引导条(中性文案"多设备共享自选与AI配置"防误开新身份)
- `scripts/migrations/migrate-sync.sql` + `scripts/cleanup-sync-snapshots.ts`(挂 run-daily, 90天TTL)

**部署**：git push 后服务器 `npx prisma db execute --file=scripts/migrations/migrate-sync.sql` → `npx prisma generate` → `npm run build` → `pm2 restart stock-analysis`。验证：双浏览器配对/自动同步/回声不抖动(version不暴涨)/psql抽查blob为密文/微信内置浏览器实测(z降级路径)。

**Why**: 真账号系统(手机号注册)合规+安全成本对群工具不成比例；同步码零个人信息、零知识叙事是卖点。
**How to apply**: 加同步内容→blob v2+applyRemoteBlob按v适配（纯新增可选键可不升 v，如 08-17 `data.share` 软加，见 [[share-feature]]）；改限流→lib/rate-limit.ts；新统计面板照 [[review-modal-consolidation]]。关联 [[server-info]](部署流程) [[naming-compliance]](文案口径)。
