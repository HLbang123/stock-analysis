/**
 * 短线策略 — 百分制强弱打分（0-100，与 AI 筛选打分对齐）
 *
 * 因子来源：
 *   - 形态/量能/市值因子：candidate.metrics（engine 算好）
 *   - 板块共振：scanner 用概念板块日线算（maxShadow / sectorVolRatioT）
 *
 * 全部为规则式分档（不做连续曲线防过拟合），档位分值由**联合拟合**得出而非手拍。
 * 龙四阴/板三阴不细化，用 priority 映射兜底，保证六套策略统一 0-100 排序。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 仙人指路：2026-09-10 从「冲高胜率」口径全面切换到「冲高幅度」口径
 * ─────────────────────────────────────────────────────────────────────────────
 * 为什么切：旧权重是「每个因子单独量边际效应 → 相加」，而本策略的出场是**次日冲高卖**，
 * 卖的是价格（幅度）不是概率。五年 17,356 条信号（2022~2026，剔 924）实测：
 *
 *   口径                现状打分(旧)   目标=P(冲高>0)最优   目标=P(冲高≥2%)最优
 *   top20 P(冲高>0)        93.20%         91.96%              87.61%
 *   top20 P(冲高≥2%)       43.27%         40.51%              47.10%
 *   top20 冲高均值          2.220%         2.138%              2.603%
 *   AUC(冲高≥2%)           0.5167         0.5009              0.5724
 *
 * 两个口径的排序 Spearman 仅 0.095（几乎正交），7 个主力因子里 5 个方向相反：
 * confVolRatio / changePct / macdQuad / maxShadow / confClosePos 全部反号。
 * 旧打分在「P(冲高>0)」上其实是样本外最优的（93.20% > 专门拟合的 91.96%），
 * 所以问题从来不是"权重拍歪了"，而是**口径与出场方式不一致**。
 *
 * 本次权重 = 对 min(T+1冲高%, 5.0) 做联合拟合（每档一个哑变量、cell-means 无截距，
 * 共线性由模型处理；档间跨度 t_span<1.5 的因子整体归零）后按统一标尺摊成整数分：
 * 「最大因子跨度 0.545pp 记 50 分」→ 1 分 = 0.0109pp，跨因子可比（这是修掉旧表
 * "每分对应的 pp 相差 6 倍"的关键）。原始分满分 311，显示时按原始分/180 归一到 0-100
 * （见 XIANREN_DISPLAY_ANCHOR，不用 311 当分母的理由写在那里）。
 *
 * 留一年法样本外效果：top20 冲高均值 2.220% → 2.649%（+19%），AUC(冲高≥2%) 0.5167 → 0.5733；
 * 五等分单调 1.479%(最低) → 2.969%(最高)，而胜率保持平的（86~89%）——幅度口径不靠牺牲胜率换。
 *
 * ⚠️ 已知代价（必须知情）：切口径后选中的是"更弹"的票，下行也更大——
 *    T+1 最低 -1.887% vs 旧表 -1.519%；T+5 收盘卖 +0.521% vs 旧表 +0.953%（不适合格局）。
 *    策略价值全部来自"次日冲高卖"，不格局。
 *
 * 两处结构性修正：
 *   1) 弃用 hitCount：它与 maxShadow 的 Spearman 相关 = 0.99（命中板块越多，"最强上影"
 *      自然越大，是机械函数），旧表把它们当两个独立因子共给了 70 分。两者同时入选时
 *      归属不稳定，去掉 hitCount 后样本外 AUC 反而最高（0.5733）、参数从 48 降到 43。
 *      hitCount 仍照常输出到 metrics，供 UI 展示「板块爆发/板块发酵」标签。
 *   2) sectorVolRatioT 的方向翻回来了：旧表按"冲高>2%"口径给放量 +8，在本口径下
 *      缩量板块（0.7~1.0）才是最优档（35 分），放量（≥1.5）只有 0 分。
 */

import type { ShortTermCandidate } from "./types";

function num(m: Record<string, unknown>, k: string): number | null {
  const v = m[k];
  return typeof v === "number" && Number.isFinite(v) ? (v as number) : null;
}

/** 递减因子分档（越低越好）：tiers 从低到高 [阈值, 分值]，命中第一个 <= 阈值的档。 */
function stepDown(v: number | null, tiers: [number, number][]): number {
  if (v == null) return 0;
  for (const [th, pts] of tiers) if (v <= th) return pts;
  return 0;
}

const PRIORITY_SCORE: Record<string, number> = { high: 80, medium: 55, low: 30 };

/** 仙人指路原始分满分 = 各因子满档之和（改下方档位时同步改这里，否则刻度会漂） */
const XIANREN_RAW_MAX = 311;
/**
 * 显示锚点：原始分 180（≈历史 p96）记为 100 分。
 *
 * 为什么不用 311 当分母：理论满分要求 10 个因子**同时**踩中各自最优档，五年里基本没出现过，
 * 拿它当 100 会让中位数只有 29 分（看着像全员不合格）。改用 180 后 p50=50、p90=72，
 * 且顶部截断（原始分 >180，占 1.6% 的信号）只影响 1.1% 的交易日出现并列——
 * 并列会破坏顶部排序（scanner 同分时退回按 priority），这是本方案唯一的已知代价。
 */
const XIANREN_DISPLAY_ANCHOR = 180;

export function scoreCandidate(c: ShortTermCandidate): number {
  const m = c.metrics;
  let s = 0;

  if (c.strategy === "xian-ren-zhi-lu") {
    // ── 确认日量比：单调递增，放量确认是本口径下最强因子之一
    //    >=2.5 → 47 分（调整后冲高均值 +0.569pp, t=10.0）；1.5~2.5 → 11 分；<1.5 → 0 分
    const confVolRatio = num(m, "confVolRatio");
    if (confVolRatio != null && confVolRatio >= 2.5) s += 47;
    else if (confVolRatio != null && confVolRatio >= 1.5) s += 11;

    // ── 试盘日涨幅：单调递增（旧表按胜率口径给"越小越好"，方向相反）
    //    >2% → 50 分（+0.590pp, t=12.0，5 年逐年一致最优）；1~2% → 14 分；0.5~1% → 6 分
    const changePct = num(m, "changePct");
    if (changePct != null && changePct > 2) s += 50;
    else if (changePct != null && changePct > 1) s += 15;
    else if (changePct != null && changePct > 0.5) s += 7;
    else if (changePct != null && changePct > 0) s += 3;

    // ── 60 日涨幅：越跌透越弹（两端都正，深跌端最强）
    //    <=-30% → 42 分（+0.460pp, t=7.7）；-30~-20% → 21 分；-20~-10% → 3 分；-10~0% → 0；>0% → 14 分
    const gain60 = num(m, "gain60");
    if (gain60 != null && gain60 <= -30) s += 42;
    else if (gain60 != null && gain60 <= -20) s += 21;
    else if (gain60 != null && gain60 <= -10) s += 3;
    else if (gain60 != null && gain60 > 0) s += 14;

    // ── 确认日上影反包强度（maxShadow = 最强命中概念的上影幅度）
    //    2.5~3 → 49 分（+0.525pp, t=6.1）；2~2.5 → 18 分；>=3 → 15 分；<2（含无共振）→ 0 分
    const maxShadow = num(m, "maxShadow") ?? 0;
    if (maxShadow >= 3.0) s += 15;
    else if (maxShadow >= 2.5) s += 49;
    else if (maxShadow >= 2.0) s += 18;

    // ── 最强命中板块的当日量比：缩量板块反包更好（旧表方向反了）
    //    0.7~1.0 → 35 分（+0.356pp, t=4.5）；1~1.5 → 28 分；<0.7 → 23 分；>=1.5 → 0 分
    //    板块数据缺失（落后/未同步）→ 13 分（中性档，对全市场一致故不影响排序）
    const sectorVolRatioT = num(m, "sectorVolRatioT");
    if (sectorVolRatioT == null) s += 13;
    else if (sectorVolRatioT >= 1.5) s += 0;
    else if (sectorVolRatioT >= 1.0) s += 28;
    else if (sectorVolRatioT >= 0.7) s += 35;
    else s += 23;

    // ── 试盘日量比（旧表未用）：缩量试盘更好——"缩量试盘 + 放量确认"是本表的连贯叙事
    //    <1.2 → 30 分（+0.407pp, t=13.2）；1.2~1.6 → 19 分；1.6~2.2 → 5 分；>=2.2 → 0 分
    const volRatio = num(m, "volRatio");
    if (volRatio != null && volRatio < 1.2) s += 30;
    else if (volRatio != null && volRatio < 1.6) s += 19;
    else if (volRatio != null && volRatio < 2.2) s += 5;

    // ── MACD 象限（旧表给 g1 加分，方向相反）：金叉且 DIF 在零轴上（g0）= 中期已转强
    //    g0 → 20 分（+0.341pp, t=13.0，5 年逐年一致最优）；g1 → 11 分；d0 → 7 分；d1 → 0 分
    const macdQuad = m["macdQuad"];
    if (macdQuad === "g0") s += 20;
    else if (macdQuad === "g1") s += 11;
    else if (macdQuad === "d0") s += 8;

    // ── 确认日反包上影比例（旧表未用，单调递增）
    //    >=100%（收上试盘日最高）→ 18 分（+0.345pp, t=14.0）；80~100% → 8 分；60~80% → 2 分
    const confPct = num(m, "confPct");
    if (confPct != null && confPct >= 100) s += 18;
    else if (confPct != null && confPct >= 80) s += 8;
    else if (confPct != null && confPct >= 60) s += 2;

    // ── 确认日收盘位（旧表未用）：收在当日最高附近最好；中段（0.85~0.95）反而最差
    //    >=0.95 → 12 分（+0.385pp, t=15.6）；0.7~0.85 → 1 分；0.85~0.95 → 0 分
    const confClosePos = num(m, "confClosePos");
    if (confClosePos != null && confClosePos >= 0.95) s += 12;
    else if (confClosePos != null && confClosePos < 0.85) s += 1;

    // ── 流通市值：小市值仍占优但**权重很小**（旧表给 24/17/8，实测跨度仅 0.091pp = 8 分）
    //    <30 亿 → 8 分；30~50 亿 → 5 分；50~100 亿 → 3 分；>=100 亿 → 0 分
    const circMvYi = num(m, "circMvYi");
    if (circMvYi != null && circMvYi < 30) s += 8;
    else if (circMvYi != null && circMvYi < 50) s += 5;
    else if (circMvYi != null && circMvYi < 100) s += 3;

    // 显示归一：线性保序；180 以上截断到 100（截断会带来并列，见 XIANREN_DISPLAY_ANCHOR 说明）
    return Math.max(0, Math.min(100, Math.round((s / XIANREN_DISPLAY_ANCHOR) * 100)));
  }

  if (c.strategy === "limit-up-board") {
    // ── 封板（打板）排序 ────────────────────────────────────────────────────
    // 依据：**排序口径实测**（不是设计猜测）。池子＝全市场封板 ∩ 换手≥10%，
    // 判据＝「Top5 的日度等权均值 vs 池子整体」（五年 34,412 条 / 十年 54,861 条双向验证）：
    //
    //   排序因子              五年Top5  超池子   配对t   逐年    十年
    //   量比↓（缩量优先）        2.708   +1.165  20.40   5/5   10/10  ← 最强
    //   换手率↓（低换手）        2.096   +0.553  11.70   5/5   10/10
    //   开盘跳空↑（高开优先）    2.056   +0.513   8.15   5/5   10/10
    //   三者合成（本表）         2.874   +1.331  23.78   5/5   10/10  ← 最优
    //   MACD g0 优先            1.352  **−0.191** −4.21 **0/5**  1/10  ← 反向，已删
    //
    // ⚠️ 为什么删掉 MACD：池子里 g0 占 56.7%、收益 +1.728% 仅比池子高 +0.118pp，
    //    但 g0 组平均换手 14.51%（四象限最高，d1 只有 9.84%）→「g0 优先」实际等价于
    //    「高换手优先」，而高换手是负向的，净效果为负。**初版把 MACD 当加分项是错的。**
    // ⚠️ 量比与换手率相关系数仅 +0.087，是独立信息：控制换手后每个换手档内量比仍单调
    //    （换手 15-25% 档：量比最缩组 +2.17% vs 最放组 +0.49%）。所以「缩量」≠「买不到」。
    // ⚠️ 合成的代价：Top5 日标准差 2.32%（不排序 1.26%）、最差单日 −4.97%。
    //    排序在提高收益的同时**提高集中度**，不是免费的。
    const vRatio = num(m, "confVolRatio");
    if (vRatio != null) {
      if (vRatio < 1) s += 45;
      else if (vRatio < 1.5) s += 36;
      else if (vRatio < 2) s += 27;
      else if (vRatio < 3) s += 15;
      else if (vRatio < 4.5) s += 5;
    }
    const turnover = num(m, "turnoverRate");
    if (turnover != null) {
      if (turnover < 7) s += 30;
      else if (turnover < 10) s += 24;
      else if (turnover < 15) s += 16;
      else if (turnover < 25) s += 6;
    }
    const gap = num(m, "confOpenGap");
    if (gap != null) {
      if (gap >= 3) s += 25;
      else if (gap >= 1) s += 18;
      else if (gap >= 0) s += 11;
    }
    return Math.max(0, Math.min(100, Math.round(s)));
  }

  if (c.strategy === "double-dragon") {
    if (m["secondOneWord"] === true) s += 60;
    s += stepDown(num(m, "board2VolRatio"), [[0.7, 40], [1, 20]]);
    return Math.max(0, Math.min(100, Math.round(s)));
  }

  // 龙四阴 / 板三阴：不细化，用 priority 映射
  return PRIORITY_SCORE[c.priority] ?? 50;
}
