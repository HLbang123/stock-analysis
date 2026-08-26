---
name: codegraph-tooling
description: CodeGraph 代码图谱（v1.5.0，CLI 全局装好、项目索引自动增量）——CLI 用法为主；DSH 下挂 MCP 的配置写法（旧的 Claude Code 集成已作废）
metadata:
  node_type: memory
  type: project
  modified: 2026-08-24T02:00:00.000Z
---

[CodeGraph](https://github.com/colbymchenry/codegraph)（npm `@colbymchenry/codegraph` **v1.5.0**，MIT）替代"AI 会话重新探索代码"的成本，与 [[project-architecture]] 互补：**它管「代码在哪 / 谁调谁」，记忆只管业务语义**。

## 当前状态（2026-08-24 复核）

- **CLI 可用**：装在 npm 全局（`C:\Users\27621507\AppData\Roaming\npm`），`codegraph` 直接能跑。
- **项目索引健康**：`.codegraph/`（node:sqlite WAL，已在 .gitignore）——215 文件 / 2179 符号 / 6410 边 / 10.17MB，**文件监听自动增量同步**，不用手动 re-index。
- 遥测已关（`codegraph telemetry off`）。
- ⚠️ **MCP 当前没挂**：旧的集成是写 `~/.claude.json` + `~/.claude/CLAUDE.md`（Claude Code 时代），**在 DSH 下完全失效**。现在只有 CLI 这一条路可用；想要 MCP 工具形态见下节。

## 日常用法（CLI，随时可用）

- `codegraph explore "<任务或符号>"` — 一把拿相关符号源码 + 调用路径，**定位首选**（输出与 MCP 的 `codegraph_explore` 完全一致）
- `codegraph query <名>` — 符号搜索（FTS5）；`codegraph node <名>` — 单符号源码 + 调用链
- `codegraph impact <符号>` — 改动影响面（实测 `impact addToWatchlist` 列出 scanner / 标的详情 / watchlist 三页）
- `codegraph callers/callees <符号>` — 调用方/被调方；`codegraph affected <文件>` — 受影响测试
- `codegraph status` — 索引健康；`codegraph files` — 项目结构；`codegraph sync` — 手动同步增量

**这个仓库改 `services/alertRules.ts` 这类多消费方文件时，先 `codegraph impact`，再对 [[alert-rules-refactor-plan]] 的辐射地图交叉验证**——两者一个是机器视角一个是人工视角，互相补漏。

## 在 DSH 里挂成 MCP 工具（未实测，要试再照做）

DSH 自带 `@deepseek-ai/dsh-mcp-client`（0.1.0-rc.7），能把外部 MCP 服务器的工具注册成 `mcp__<serverName>__<原名>`。做法 = 往 profile 的**用户补丁层** `~/.dsh/profiles/<profile>/cordis.patch.yml` 加一条 insert 条目（该文件顶层是 YAML 数组，默认 `[]`）：

```yaml
- insert:
    - id: mcp-codegraph
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: codegraph
        transport: stdio
        command: codegraph
        args: ['serve', '--mcp']
        cwd: D:\tool\web\stock-analysis
```

- 挂上后模型侧工具名是 `mcp__codegraph__explore` / `mcp__codegraph__node` 等。
- 验证：`dsh --profile desktop --dump-config` 应能看到这条 entry；再开新会话看工具列表。
- **Windows 坑（未验证）**：npm 全局 bin 是 `codegraph.cmd`，stdio 直接 spawn `codegraph` 可能 ENOENT。真报错就把 `command` 改成绝对路径 `C:\Users\27621507\AppData\Roaming\npm\codegraph.cmd`，或 `command: cmd` + `args: ['/c','codegraph','serve','--mcp']`。
- 成本考量：MCP 每轮请求都带工具 schema，CLI 是零常驻开销。**只用 CLI 完全够用**，挂 MCP 只是为了省掉手敲命令。

## 维护

- 升级：`codegraph upgrade`（走 npm registry）
- 索引异常：`codegraph unlock`（去陈旧锁）→ `codegraph index`（全量重建，本项目约 1.6s）
- 卸载：`codegraph uninit`（删项目 `.codegraph/`）+ `npm rm -g @colbymchenry/codegraph`
- 本机访问 github.com 不稳（解析到 Azure 亚太边缘节点，clone 时通时不通；api.github.com 稳定）——升级走 npm registry 不受影响。

## 换新电脑部署

```bash
npm i -g @colbymchenry/codegraph   # ① CLI 上 PATH
codegraph telemetry off            # ② 关遥测（默认开）
cd <项目根> && codegraph init      # ③ 建索引（.codegraph 在 .gitignore，不随 git 走）
```

`.gitignore` 里的 `/.codegraph/` 已随仓库走，新机器 clone 下来天然干净。要 MCP 形态再按上节写 `cordis.patch.yml`。
