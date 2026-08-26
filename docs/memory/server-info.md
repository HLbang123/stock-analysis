---
name: server-info
description: 硅云香港服务器连接/架构/部署信息——IP、SSH、nginx、PM2、PG 调优、防火墙、链式部署命令、自动化 SSH（凭证不入仓）
metadata:
  node_type: memory
  type: project
  modified: 2026-08-24T01:55:00.000Z
---

硅云香港 CVM，跑本项目的生产环境。**2 核 CPU / 3.8GB RAM / 2GB swap**——重活批处理一律排夜间，白天撞批处理必卡。

## 连接

- IP `103.151.217.28`，SSH `root@103.151.217.28`（密码登录，本机 `~/.ssh/config` 已配别名）
- 项目路径 `/home/stock-analysis`（git 仓库，`git pull` 拉新代码）
- **🔒 凭证不写进本仓库**（本文件已推到 GitHub，任何密码写在这里等于公开）。root 密码与 PG 密码走本机凭证管理/`~/.ssh/config`/`.env.local`，需要时问用户。
  - `/tmp/askpass.sh`（自动化 SSH 用，见下）里存着 root 密码明文——**改服务器密码后必须同步更新这个文件**，否则自动化 SSH 全挂。
  - PG 连接串在服务器 `.env.local`（dotenvx 加密）。库名 `stock_analysis`、用户 `quant_user`、`localhost:5432`；密码从 `.env.local` 取，别硬编码在脚本里。

## PostgreSQL（2026-08-17 调优过，别再当默认配置排查）

- **跑在 docker 容器 `stock_pg`（postgres:15，无内存限制）**；重启：`docker restart stock_pg`（shared_buffers 改动必须重启才生效）
- 已调优：shared_buffers=1GB / effective_cache_size=2.5GB / work_mem=32MB / maintenance_work_mem=256MB / random_page_cost=1.5 / max_parallel_workers_per_gather=1 / jit=off；rps_scores + daily_bars 设了 autovacuum_analyze_scale_factor=0.01
- 排慢查询：`pg_stat_activity` 看 active 长跑 SQL；`pg_terminate_backend(pid)` 杀
- **大批量写入后第一件事必须手动 ANALYZE**（10 年回补后没刷，统计过期致全站 RPS 查询走并行全表扫，load 9 事故；2026-08-17）

## 长跑脚本三铁律（2026-08 血泪）

1. **必须 `setsid`**（nohup 护不住 npx/tsx 子进程，SSH 断开收 SIGHUP 被杀过）
2. **大内存脚本加 `NODE_OPTIONS="--max-old-space-size=3584"`**（backtest-factors 全量峰值 ~2.8GB，默认 2GB 堆必 OOM）
3. **串行 `&&` 链**（build 与批处理互不重叠抢内存）

## 已修的性能债（2026-08-17，别再犯同 pattern）

- `/api/rps/batch`：曾拉每票全部历史 RPS 再 JS 去重（10 年数据后 12 万行/请求）→ 改 DISTINCT ON 只取最新
- `/api/kline/batch`：窗口函数曾读每票全历史 → 加日期下界（days×2 日历日）
- 排查同类雷区的模式：大表查询无日期边界 / 拉全量到 JS 处理（详见 [[ten-year-data-scale]]）

## 架构

- nginx 监听 80+443 反代到 `Next:3000`；PM2 进程名 `stock-analysis`（`next start`，Next 16.2.10）
- 80 端口 `default_server`（server_name `_`）= IP 直连 HTTP 兜底入口
- 443 端口 = `xkls888.top` 的 Let's Encrypt 证书（Certbot 管），域名 HTTPS
- **443 IP HTTPS 现成可用**：访 `https://103.151.217.28/login` 会拿到 xkls888 证书 → 主机名不匹配警告 → 点继续 → 加密可用，ISP 掐不了（运营商 SNI 阻断时给用户的备选入口）
- nginx 配置在 `/etc/nginx/sites-enabled/*`，日志 `/var/log/nginx/access.log`（诊断用户问题可 `grep 用户IP` 看请求）

## 防火墙

- 硅云平台防火墙用模板，只开 80/443/22/3389；**8080 等自定义端口被平台层拦**（服务器内 iptables 是 ACCEPT 但外部进不来）
- 要开非标端口得在硅云网页控制台加规则，改服务器内 iptables 没用

## 部署

- **链式一行命令（无 schema 改动，交给用户交互式粘贴执行）**：
  `cd /home/stock-analysis && git pull && npm run build && pm2 restart stock-analysis && sleep 6 && bash scripts/warmup.sh`
  （`&&` 链天然保证 build 失败就停、不重启。）
- **有 schema 改动**：上一条在 `npm run build` 前插 `npx prisma generate`。
- **链式命令是模板，按需插步**：给用户命令前先判断本轮有没有额外尾巴，直接串进链里、别让用户单独跑——①服务器被手动改过、`git pull` 会冲突/覆盖，先处理服务器侧（`git stash`/备份被覆盖文件）或改用 base64 直传再 pull；②DB 迁移/回补（`npx prisma db execute --file=xxx.sql` 或 `npx tsx scripts/backfill-*.ts`，按脚本性质插 build 前或 restart 后）；③大批量写后补 `ANALYZE rps_scores; ANALYZE daily_bars;`（restart 后跑）。
- warmup.sh 预热关键路由：把 Next 冷启动 + Prisma 首连的成本从用户首次点击转移到部署时（约 12~16s；冷启动只在 pm2 restart 后发生一次）。
- **prisma schema 有改动时**（加 `@map`/新增 model/改字段）：`npm run build` 之前必须 `npx prisma generate`（`next build` 不会自动重新生成 client，否则 ColumnNotFound/ModelNotFound）。改 schema **不跑** `prisma db push`。
- **别跑 `npx prisma db push`**：daily_bars 有孤儿数据（ETF/退市代码不在 stocks 表）会卡在外键约束。AI 筛选表已 raw SQL 建表绕过。要彻底修：先 `DELETE FROM daily_bars WHERE ts_code NOT IN (SELECT ts_code FROM stocks); DELETE FROM rps_scores WHERE "tsCode" NOT IN (SELECT ts_code FROM stocks);` 再 db push
- `.env.local` 是 dotenvx 加密，`psql` grep 不到明文；跑 DDL/DML 用 `npx prisma db execute --file=xxx.sql`（自动解密）。prisma 7.x 的 `db execute` 不认 `--schema`，数据源从 `prisma.config.ts` 读
- **检查是否已同步**：`git fetch && git rev-parse HEAD` vs `git rev-parse origin/main` 对比哈希，`git log origin/main --oneline -3` 看远端最新

## 自动化 SSH（agent 自己连服务器时）

- 本机**无 sshpass**，用 **SSH_ASKPASS** 传密码：
  ```bash
  export SSH_ASKPASS=/tmp/askpass.sh SSH_ASKPASS_REQUIRE=force; ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 root@103.151.217.28 "echo SSH_OK"
  ```
  `/tmp/askpass.sh` 已存在（内容 = `#!/bin/bash` + `echo "<root密码>"`），直接用；**改服务器密码后要更新它**。
- **传文件用 base64 内联单行**（这是"临时改服务器文件/跑一次性脚本"的通道，之后 git pull 会覆盖）：
  `ssh ... "echo $(base64 -w0 本地文件) | base64 -d > 服务器路径"`。服务器有 base64 ✓，几百 KB 内没问题。
- 服务器**无 psql 二进制**，查库用项目自带 `pg` 模块直连：`node -e "const pg=require('pg');new pg.Pool({connectionString:process.env.DATABASE_URL,max:2}).query('...',(e,r)=>console.log(r.rows))"`（连接串从 `.env.local` 取，别写死密码）。
- 服务器有 curl/wget（warmup.sh 用 curl）；**缺 sshpass/nc**，不要假设有这些命令。
- ⚠️ **历史包袱已作废**：记忆里那套「命令必须单步、不能用 `&&` 复合、不能用 heredoc、allowlist 要写进 `~/.claude/settings.json`」是 Claude Code + 中转站分类器时代的限制。**当前 DSH 下没有那个分类器**，复合命令、`&&` 串链、heredoc 都能正常用，别再自我阉割。

## 部署决策流（每次推送后走这个）

1. `git fetch && git rev-parse` 对比 HEAD vs origin/main，确定是否需要同步
2. `git diff <old>..<new> -- prisma/schema.prisma` 检查 schema 是否改动
3. 如 schema 有改动 → `npx prisma generate`（不跑 db push）
4. `npm run build`（约 3-5 分钟）
5. `pm2 restart stock-analysis && sleep 6`
6. `curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/login` 验证返回 200
7. `pm2 logs stock-analysis --lines 10 --nostream | grep -iE 'error|ready'` 确认无启动错误

用户 git 推送习惯（提交即待部署）见 [[user-git-habits]]。整体目录结构见 [[project-architecture]]。
