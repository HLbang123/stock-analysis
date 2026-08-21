---
name: tushare-credits
description: "用户tushare账号已有6000积分,moneyflow(2000分)和stk_holdernumber等付费接口已可直接调用,无需再充值"
metadata: 
  node_type: memory
  type: project
  originSessionId: 946f6e0b-010f-4787-b358-42944bb6b6d1
  modified: 2026-08-15T08:02:59.756Z
---

用户 tushare 账号已有 **6000 积分**（2026-08-15 确认）。

**Why:** 评估阶段FSM/控盘度分的数据成本时，曾以为 moneyflow（个股资金流，2000 积分档）需要额外充值；实际权限已够。

**How to apply:** 涉及主力净流入（`moneyflow`/`net_mf_amount`）、股东户数（`stk_holdernumber`）等 2000-5000 积分档接口时，直接接入即可，不再有购买决策。L2 逐笔仍无（tushare 不提供，需 ptrade/emquant 等其他源）。
