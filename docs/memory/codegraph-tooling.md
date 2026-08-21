---
name: codegraph-tooling
description: CodeGraph 代码图谱已装(2026-08-12)：CLI 全局+MCP 全局+项目索引自动同步；定位/影响面查询用法与维护命令
metadata: 
  node_type: memory
  type: project
  originSessionId: ec38a45a-a98b-496f-b112-069400aef5db
  modified: 2026-08-13T01:48:48.946Z
---

2026-08-12 引入 [CodeGraph](https://github.com/colbymchenry/codegraph)（npm `@colbymchenry/codegraph` v1.5.0，MIT）替代"AI 会话重新探索代码"的成本，与 [[project-architecture]] 互补：它管"代码在哪/谁调谁"，记忆只管业务语义。

**安装形态**：
- CLI：`npm i -g @colbymchenry/codegraph` 装在 npm 全局（`C:\Users\27621507\AppData\Roaming\npm`），`codegraph` 直接可用
- MCP：写入 `~/.claude.json`（`codegraph serve --mcp`，stdio）+ `~/.claude/settings.json` 权限 + `~/.claude/CLAUDE.md` 使用指引（CODEGRAPH_START/END 标记段，勿手删）
- 索引：项目根 `.codegraph/`（SQLite WAL，~8MB，已加 .gitignore），**文件监听自动增量同步**，无需手动 re-index
- 遥测已关（`codegraph telemetry off`）

**日常用法**（CLI 与 MCP 工具同名，输出一致）：
- `codegraph explore "<任务或符号>"` — 一把拿相关符号源码+调用路径，**AI 定位首选**
- `codegraph query <名>` — 符号搜索（FTS5）；`codegraph node <名>` — 单符号源码+调用链
- `codegraph impact <符号>` — 改动影响面（实测：`impact addToWatchlist` 列出 scanner/stock详情/watchlist 三页）
- `codegraph callers/callees <符号>` — 调用方/被调方；`codegraph affected <文件>` — 受影响测试
- `codegraph status` — 索引健康；`codegraph files` — 项目结构

**维护**：
- 升级：`codegraph upgrade`（自动刷新 MCP 配置）
- 索引异常：`codegraph unlock`（去陈旧锁）→ `codegraph index`（全量重建）
- 卸载：`codegraph uninstall` + `codegraph uninit` + `npm rm -g @colbymchenry/codegraph`

**注意**：本机网络访问 github.com 不稳定（解析到 Azure 亚太边缘节点，git clone 时通时不通；api.github.com 稳定）——升级走 npm registry 不受影响。同期还评估过 graphify/code-review-graph（源码在 `d:\tool\web\code-review-graph`），定位场景 CodeGraph 已够用，暂未引入。

**换新电脑部署**（全程 npm registry，无需访问 github；前置：装好 Node 18+ 和 Claude Code）：
```bash
npm i -g @colbymchenry/codegraph   # ① CLI 上 PATH
codegraph install -y               # ② 写 MCP 配置(~/.claude.json)+权限+全局指引
codegraph telemetry off            # ③ 关遥测(默认开)
cd <项目根> && codegraph init      # ④ 重建索引(.codegraph 在 .gitignore 里,不随 git 走;本项目 1.6s)
```
然后重启 Claude Code。注意 `.gitignore` 里的 `/.codegraph/` 条目已随仓库走，新机器 clone 下来天然干净。记忆目录 `~/.claude/projects/<项目路径哈希>/memory/` 是机器本地的，换机需另行拷贝（不在 CodeGraph 范围）。
