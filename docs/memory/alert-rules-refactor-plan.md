---
name: alert-rules-refactor-plan
description: 预警规则辐射范围地图——14条(R01-R14)编号+所有消费方引用点+严重度分级展示，改规则ID/条件先查此地图
metadata: 
  node_type: memory
  type: project
  modified: 2026-08-19T05:25:53.938Z
  originSessionId: 9f9f9778-8b6a-4871-92bb-b0ab7836e0f6
---

预警规则**辐射范围地图**。改规则 ID、条件、顺序时，先对照此地图同步所有消费方，避免漏改。

## 当前编号（2026-08-05 起 14 条；妇联定律已删，原 R05-R15 顺移为 R04-R14）

事实源 `services/alertRules.ts`。**改规则 ID 时只用改 alertRules.ts + 下方消费方里的硬编码引用**，然后 `tsc` 全绿即可。

| ID | 规则 | 分组 | 级别/可信度 |
|---|---|---|---|
| R01 | 见顶阶梯 | 卖出 | CRITICAL / A |
| R02 | 离场阶梯 | 卖出 | CRITICAL / A |
| R03 | 跌破55日线 | 卖出 | WARNING / B |
| R04 | 5/13金叉 | 买入 | A |
| R05 | 5/10金叉 | 买入 | B |
| R06 | 止跌企稳 | 买入 | A |
| R07 | RSI超卖 | 买入 | A |
| R08 | 反包入场 | 买入 | B |
| R09 | 黄金位反弹 | 买入 | B |
| R10 | 箱体信号 | 买入 | B |
| R11 | 均线多头排列 | 买入 | B |
| R12 | 站稳五日线 | 买入 | B |
| R13 | 筹码低位密集 | 参考 | B |
| R14 | 筹码高位套牢 | 参考(归卖出侧) | B |

- `SELL_RULE_IDS={R01,R02,R03,R14}`；`REFERENCE_RULE_IDS={R08,R11,R13,R14}`（08-17 起 R08反包/R11多头排列 移入，十年回放双双负 alpha；不计入买入共振硬聚合）。
- `RULE_RELIABILITY` A级={R01,R02,R04,R07,R10}（08-17：R06降B=接飞刀均值-0.24%，R10升A=箱体T+5+0.71%），其余 B 级。`buyRuleWeight`：买入 A=2/B=1，卖/参考=0。
- **2026-08-17 去仓位化**：所有规则 message/suggestion 只报信号方向与强度（强卖出/卖出/弱提醒/强势确立），清仓/减仓/加仓/止盈措辞全删；R12 改名「站稳五日线」。仓位建议仍归深度分析 AI 风控角色（其职责域，不动）。
- R01 子信号现状：对子顶(5)/巨量见顶(4,量比≥4x升5)/第二波见顶(4)/涨停炸板(4)/巨量异动(1)。**形态类见顶(长上影/长下影/跳空衰竭/纺锤线)与涨停封板已全部删除**（生产胜率+十年回放反复证伪；封板 T+5 +1.48% 是强势延续）。

## 消费方 / 辐射引用点（改 ID 必查）

- **`services/alertRules.ts`** — 源。`ALERT_RULES`、`checkAllRules` switch、`SELL_RULE_IDS`/`REFERENCE_RULE_IDS`/`RULE_RELIABILITY`/`buyRuleWeight`/`isStrongSellAlert`/`severityAlertLevel`/`formatTriggeredRulesForAI`。
- **`services/deepAnalysisPrompt.ts`** — `RULES_TABLE`(14行速查表，已与现编号同步) + prompt 正文引用。
- **`services/deep-analysis/levels.ts`** — `extractBoxHigh` 判 `ruleId==='R10'`(箱体上沿)；`countBuySignals` 的 `buyIds={R04,R05,R08,R09,R10,R11,R12}`。
- **`services/t-score/scorer.ts`** — `CRITICAL_SELL_IDS`(CRITICAL 级卖出，买入分兜底)。
- **`app/stock/[code]/page.tsx`** — 分时图标记按 ruleId 分流（见顶→最高价/见底→最低价），find 对未知 ruleId 已降级。
- **`app/page.tsx`** — 预警页分组+买入共振档位+严重度分级着色（见下）。
- **`components/AlertRulesModal.tsx`** — 规则说明弹窗，按 ALERT_RULES 数组顺序分组展示。**2026-08-15 起为全站规则说明枢纽**：顶部 Tabs 切 预警规则/波段打分/市场扫描 三块文档（波段打分=8买+8卖因子口径，市场扫描=RPS/乖离/箱体算法/阶段预设），预警 tab 顶部加了通用机制说明（级别/阶梯/共振/量能折算/品种适配）。
- **`docs/alert-rules.md`** — 人工参考文档，与代码同步维护。
- **`components/UpdateLog.tsx`** — 历史变更日志**故意保留旧编号**，改规则时不用动。

## 持久化与兼容

- 无 Prisma 规则表；预警记录存 localStorage(Zustand `AlertRecord.ruleId`)。改/删 ID 会孤立旧记录，`find` 已降级兜底不崩。
- R01/R02 extraData 结构 `{main, sev, triggered[]}`；旧记录无 `sev` → `isStrongSellAlert` 保守按强处理。

## 设计要点（保留）

- 卖出侧阶梯化：R01 见顶/R02 离场，内部按严重度择优只出一条，extraData 列全部命中子信号。
- 买入侧**不做**择优阶梯：多信号叠加确认，展示层聚合成「买入共振强度档位」(弱观察1/温和2/较强3/强烈≥4)；`volConfirmed` 放量确认 +1 档。
- **严重度分级展示(2026-08-10)**：R01/R02 extraData 落主信号 `sev`(1~5)。`isStrongSellAlert`(sev≥3 或 R03 等单信号规则) 才是强卖出→整卡染绿+摘买入徽章；sev≤2 弱提醒(巨量异动/涨停封板/跌破5日线/MA5拐头) 仅行内绿条，不染卡不摘徽章。`severityAlertLevel`：sev≥4 CRITICAL/3 WARNING/≤2 INFO，落库 alertLevel + worstLevel 排序同用。缘起：有研新材 4 条买入共振被一条巨量异动(sev1)整卡染绿、徽章被摘。
- **盘中量能归一化**：所有"今日量 vs 基线"判断走 `effectiveTodayVolume`(盘中合成 bar 按 `intradayVolumePace` U形锚点折算等效全日量)；基线用 `slice(0,-1)`。巨量异动例外：用已成交量不折算(确认性优先，哈药 8/05 pace 误报案例)。
- 统一 K 线形态 `classifyCandle`(影线/实体比互斥)，位置分流：长下影连涨后=R01 顶部，下跌末段=R06 底部锤子。
- 复活键=股票+规则+主信号(extraData.triggered[0])，防不同子信号交叉复活旧记录(有研新材 8/10 涨停误报根因)。
- **复活键只对多子信号阶梯生效(2026-08-10 修复)**：单信号规则(R04-R12 买入等)extraData 无 `triggered` → 若也走主信号匹配会 `'' ≠ 规则名` 永不复活、每次检查都新建，累积"有效+划痕线"并存且过期项被计入买入共振。page.tsx 判定 `subs.length===0 → 规则级匹配`；并加清理：同(股票|规则|主信号)的过期重复被有效预警遮蔽则丢弃(清存量)。
- **买入共振计数只算有效(isExpired=false)预警**：`buyAlerts = stockAlerts.filter(!a.isExpired && isBuyRule && !REFERENCE)`——划痕线过期信号不再计入 buyScore/档位/条数。

## 变更历史

- **2026-08-19**：R12「站稳五日线」新增**高位跌落过滤**（`checkHoldMa5` 加 `MAX_PREV_BIAS=0.05`：站稳前5日收盘较MA5乖离>5%视为高位跌落，不报）——修复从5日线上方很远跌回附近却误报积极信号的 bug。全市场回测验证（5743只/371879触发样本，近5年）：乖离>5%那批 T+5均值**-0.25%**/T+10**-0.14%**、胜率42.6%/44.2%（确为负信号）；≤5%保留批 T+10+0.60%。5%是负/正分界甜点，阈值**维持0.05**。消费方已同步：规则 description + docs/alert-rules.md（表格+正文两处）。同日 R02「跌破5日线」子信号补下穿检测（`priceCrossedBelowWithin(kLines, ma5, idx, 2)` 替代纯 `close<ma5`），避免从低位反弹未站上 MA5 时误报跌破；docs/alert-rules.md R02 表格同步。
- **2026-08-17**：买入侧十年全市场回放首批调整（explore-alert-rules --days=2350，792只×2350日）：R08/R11 移入参考级、R06 降B、R10 升A、R01 删长上影/长下影/涨停封板、巨量≥4x 升 sev5、R12 改名、全规则去仓位化。对子顶/急跌两口径冲突未动，继续观察。
- **2026-08-15**：删 R01 跳空衰竭/纺锤线见顶（生产胜率 T+5 均值 +0.09%/+0.06% 为正=纯噪声）；孤儿函数 gapUpPercent 一并移除；isSpinning 形态分类保留（classifyCandle 共用工具）。
- **2026-08-10**：严重度分级展示(extraData.sev + isStrongSellAlert/severityAlertLevel)；复活键细化到子信号级；删 MA5拐头、5/13死叉按破55日线分级；修复复活键误伤单信号规则+买入共振计入过期项。
- **2026-08-05**：删 R04 妇联定律，14 条重排；形态类见顶降级弱提醒；第二波需真高潮；删放量离场/缩量破位(回测无区分度/反向)。
- **2026-08-04**：量能盘中归一化(effectiveTodayVolume/intradayVolumePace)；R08 反包补真实放量硬条件。
- **2026-08-03**：编号重排连续 R01-R15；新增 5/10金叉；预警页买入共振强度档位。
- 2026-07-27 卖出侧阶梯化；2026-07-22 29→16 合并。
