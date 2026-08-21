---
name: user-git-habits
description: 用户的 git 习惯——默认不提交不推送交给用户；用户自己 squash 成一笔 force-push
metadata: 
  node_type: memory
  type: feedback
  modified: 2026-07-28T09:56:06.556Z
  originSessionId: 649e24ea-2761-4d87-ad63-9642860a8d53
---

用户的 git 工作流与对我的要求：

- **【最重要】默认不提交、不推送，交给用户自己来**（2026-07-28 用户明确要求）。改完代码就停，由用户决定何时 squash/commit/push。只在用户明确说"提交""推送""合并成一笔"时才动 git。
- 用户自己的 squash 风格：一天工作合并成一条 `feat: ...` 提交，中文标题用 `+` 串联多个主题（如 `feat: 预警规则调整+涨停信号+买入共振聚合+扫描器板块过滤`）。
- 直接推 main，不用 PR/feature 分支，force-push（`--force-with-lease`）可接受。
- 当用户让我执行 squash（说"合并到一笔提交"）时：
  ```bash
  git reset --soft <基准commit>
  git add -A
  git commit -m "<新标题>"
  git push --force-with-lease  # 仅当用户要求推送时
  ```
- 部署走服务器 `git pull && npm run build && pm2 restart`，提交即待部署。

**Why**: 用户希望对 git 历史与推送时机保持手动掌控，避免 AI 擅自改动远端或制造零散提交。

**How to apply**: 默认只改文件不碰 git。需要提交时先问用户；用户让提交就用 squash 一笔的风格；推送只在用户明确要求时做。服务器部署只需 pull+build+restart（别跑 prisma db push，孤儿卡，见 [[server-info]]）。
