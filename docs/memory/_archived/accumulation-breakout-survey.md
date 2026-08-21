---
name: accumulation-breakout-survey
description: 吸筹突破开源项目(D:\tool\web\a-share-accumulation-breakout)调研结论——箱体判定/漏斗审计/市场regime门/信号时效分值得借鉴，板块配额明确不搬
metadata: 
  node_type: memory
  type: reference
  originSessionId: 9f41917d-e96a-4dcb-9bf9-be359e35f271
  modified: 2026-08-14T13:50:38.458Z
---

2026-08-14 调研 `D:\tool\web\a-share-accumulation-breakout`（Python，吸筹箱体突破策略），为 [[ai-screen-feature]] 找借鉴。核心结论：

**值得抄（按投入产出比）**：
1. **audit_funnel.py 漏斗审计**：逐层淘汰计数+未命中主因Top10+瓶颈判断，纯打印脚本，投入极低。我们最缺这个。
2. **signals.py 箱体判定**：分位数稳健支撑阻力 + 线性回归斜率/R²拒单边通道 + 支撑压力触及≥2次 + 摆动次数 + 前后漂移≤8% + 箱体右端锚定突破日前(防未来函数) + 突破需收盘>箱顶×1.001且量≥1.6×箱均量且涨幅2%~9.5%。是 SQL 单日统计量无法表达的形态维度，可做子因子。
3. **market_regime.py**：沪深300 close vs MA20+20日涨幅三态，防守期全局禁新开仓（我们只有个股级扣分，缺市场级 gate）；数据新鲜度按交易日 lag 而非日历日（16点前回退上一交易日）。
4. 次选：pool_select.py 信号时效分(lag0加8/lag1加5，按交易日算)；walkforward.py IS/OOS 分离+degraded/insufficient 数据不足禁声称 edge 的诚实性纪律；backtest「入场锚定信号日+1 而非采样日+1」口径 bug 自查。

**明确不搬**：sector_themes.py 每板块配额填充（该项目自己也从硬配额退回软加分 THEME_SOFT_BONUS=2.0，印证我们 2026-08-14 删同板块限2只方向正确）；prefilter/portfolio/三因子加权均有等价物。

资金流相关借鉴（净流入/成交额归一化、单日暴量骗炮-15分）受限于数据源，需先确认我们有等价 moneyflow 数据。
