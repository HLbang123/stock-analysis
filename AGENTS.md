<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:codegraph -->
# 代码定位(CodeGraph)

本仓库已建 CodeGraph 索引(`.codegraph/`,自动增量同步)。定位代码、理解调用关系、查影响面时,优先走**命令行**:
`codegraph explore "<问题或符号名>"` / `codegraph query <符号>` / `codegraph callers <符号>` / `codegraph impact <符号>`。
先 codegraph,再考虑 grep/翻文件——它一次返回符号源码 + 调用链,更准更省。
注意: MCP 形态(`codegraph_explore` 等工具)当前**没有挂载**,别去调不存在的工具;要挂见 `docs/memory/codegraph-tooling.md`。
<!-- END:codegraph -->

<!-- BEGIN:project-memory -->
# 项目记忆(必读)

长期约束/军规/功能决策沉淀在 `docs/memory/`(仓库内,已版本化)。开工前先读 `docs/memory/MEMORY.md` 索引,按任务读对应条目。**记忆是历史事故换来的规则,优先级高于默认判断。**

## 常驻军规(每次会话必守)

- **合规命名**: 对外可见文案禁用「股」字(股票/选股/荐股/个股/A股/股市/股价),改用「标的/筛选/行情」。
- **UI 文案**: 不解释技术实现,禁提模型名/数据源名/统计术语/脚本名/内部规则编号;副标题一句、tooltip 一句、空态一句。
- **git**: 默认不提交不推送,交给用户;用户自己 squash 成一笔中文 feat 直推 main。
- **数据量级**: 库是 10 年全量(daily_bars 1080 万行 / rps_scores 1035 万行);写脚本/SQL 前:日期边界必带、内存先估算、DISTINCT 配 LIMIT、先小窗试跑。
- **服务器**: 2 核/3.8G;长跑脚本 setsid + `--max-old-space-size=3584` + 串行 `&&`;大批量写后必须 ANALYZE;**别跑 `prisma db push`**。
- **预警规则**: 改规则 ID/条件先查 `docs/memory/alert-rules-refactor-plan.md`(14 条 R01-R14 辐射地图,事实源 `services/alertRules.ts`)。
- **规则说明同步**: 市场扫描/波段打分两个 tab 手写静态,改条件要手动同步;`docs/alert-rules.md` 也手写。
- **凭证不入仓**: 服务器 root 密码、DB 密码、API key 一律不写进仓库任何文件(含 `docs/memory/`)——本仓库推 GitHub,写进来等于公开。需要时问用户。
<!-- END:project-memory -->
