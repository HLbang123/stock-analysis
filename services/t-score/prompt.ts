/**
 * 波段评分 — LLM 微调 prompt
 *
 * 确定性因子分已由 scorer.ts 算好，LLM 只做有界微调(±15)+给理由+综合说明。
 * 严格 JSON 输出，靠 prompt 约束 + 路由端 parseJsonLenient 兜底。
 * 合规：对外禁"股"字用"标的"、禁"做T"用"波段"、禁"推荐/建议"用"信号参考"。
 */

import type { RuleCheckResult, IndicatorResult } from '@/types';
import type { ChipDistribution } from '@/lib/chip';
import { formatTriggeredRulesForAI } from '@/services/alertRules';
import type { IntradayContext } from './intraday';
import type { TFactorScore } from './scorer';

export function buildTscoreSystemPrompt(isETF?: boolean): string {
  const etfNote = isETF
    ? '\n本标的为 ETF，不做个股基本面判断，聚焦指数趋势/盘中量价/资金流向。\n'
    : '';
  return `你是「波段评分」的微调器。系统已用确定性因子算好买入分与卖出分(各 0-100)，你的职责：在 ±15 范围内给出微调量、说明理由、写一段综合说明。${etfNote}

## 必须遵守
1. 只返回一个 JSON 对象，不要 Markdown、不要解释性前后文。
2. buy_adjust / sell_adjust 必须是 [-15, 15] 内的整数。没有依据就给 0。
3. 微调方向：你认为因子分低估了信号强度→正调整；高估了→负调整。不得脱离因子分另起炉灶。
4. 买入分针对"逢低回踩入场"的买点信号强度；卖出分针对"盘中冲高减仓"的卖点信号强度。两者可同时高(可买可卖做波段)，也可同时低。
5. 综合说明 analysis：150-180 字，讲盘中结构(VWAP/位置/量能)、买卖逻辑、要盯什么。不要复述因子分数值。
6. buy_reason / sell_reason：各 ≤120 字，说明你为何这样微调。
7. tags：2-5 个关键词标签(如 "回踩VWAP" "尾盘放量" "近阻力")。
8. 买卖两个方向都必须给 adjust 与 reason（用户未填仓位不代表未持仓，卖点信号对任何持仓/潜在持仓者都有参考价值）。

## 合规红线(违反即废)
- 禁用"股"字(含股票/个股/A股)，用"标的"。
- 禁用"做T"，用"波段"。
- 禁用"推荐/建议/买入/卖出/加仓/减仓"等指令性词，用"信号强度/信号参考"。
- 这是信号参考，非操作指令。不得承诺收益、不得给目标价。

## 输出 JSON 格式
{
  "buy_adjust": 0,
  "sell_adjust": 0,
  "buy_reason": "…",
  "sell_reason": "…",
  "analysis": "…",
  "confidence": 0.5,
  "tags": ["…"]
}
未持仓标的也可给出 sell_adjust（用户可能在场外持仓）。confidence 为你对本次微调的把握 0-1。`;
}

function fmtFactors(factors: TFactorScore[]): string {
  return factors.map((f) => `  - ${f.name}: ${f.score} 分(权重 ${(f.weight * 100).toFixed(0)}%)`).join('\n');
}

function fmtIntraday(ctx: IntradayContext): string {
  return [
    `分时粒度: ${ctx.granularity}，共 ${ctx.count} 个点`,
    `现价 ${ctx.last.toFixed(2)} | 开盘 ${ctx.open.toFixed(2)} | 日内高 ${ctx.high.toFixed(2)} | 低 ${ctx.low.toFixed(2)}`,
    `VWAP ${ctx.vwap.toFixed(2)} | 偏离 VWAP ${ctx.vwapDevPct.toFixed(2)}% | 日内位置 ${ctx.rangePosPct.toFixed(0)}%(0=最低 100=最高)`,
    `近${ctx.windowLen}分钟动量 ${ctx.mom15.toFixed(2)} bps/分(负=回调) | 下跌分钟量占比 ${(ctx.downVolRatio * 100).toFixed(0)}% | 尾盘均量/全日 ${(ctx.last5VolRatio).toFixed(2)}`,
    ...(ctx.rsi6 != null ? [`15分RSI6 ${ctx.rsi6.toFixed(0)}${ctx.rsi6 < 20 ? '(超卖)' : ctx.rsi6 > 80 ? '(超买)' : ''} | RSI12 ${ctx.rsi12?.toFixed(0) ?? '--'}${ctx.rsiBullDivergence ? ' | 底背离' : ''}${ctx.rsiBearDivergence ? ' | 顶背离' : ''}`] : []),
    ...(ctx.macdDiff != null ? [`5分MACD DIF ${ctx.macdDiff.toFixed(3)}${ctx.macdAboveZero ? '(水上)' : '(水下)'}${ctx.macdCrossUp ? ' 金叉' : ''}${ctx.macdCrossDown ? ' 死叉' : ''}${ctx.mHead ? ` | 盘中M头(conf ${ctx.mHeadConf.toFixed(2)})` : ''}`] : []),
    `5分K放量比 ${ctx.m5VolSurgeRatio.toFixed(1)}${ctx.m5UpShrink ? ' 缩量冲高' : ''}${ctx.m5Faded ? ' 冲高回落' : ''}${ctx.m15SupportHeld ? ' | 15分支撑探底回升' : ''} | ${ctx.minuteOfDay >= 870 ? '尾盘' : '盘中'}`,
  ].join('\n');
}

function fmtIndicators(ind: IndicatorResult): string {
  const b = ind.bollinger;
  return [
    `RSI(6/14) ${ind.rsi6.toFixed(1)} / ${ind.rsi14.toFixed(1)}`,
    `MA5/10/20/55 ${ind.ma5.toFixed(2)} / ${ind.ma10.toFixed(2)} / ${ind.ma20.toFixed(2)} / ${ind.ma55.toFixed(2)}`,
    `MACD DIF ${ind.macd.dif.toFixed(3)} DEA ${ind.macd.dea.toFixed(3)} 柱 ${ind.macd.histogram.toFixed(3)}`,
    `布林 上${b.upper.toFixed(2)} 中${b.mid.toFixed(2)} 下${b.lower.toFixed(2)} 位置${b.position.toFixed(0)}%`,
  ].join('\n');
}

function fmtChip(chip: ChipDistribution | null): string {
  if (!chip) return '筹码: 无数据';
  return `筹码: 主峰 ${chip.dominantPeak.toFixed(2)} | 均本 ${chip.avgCost.toFixed(2)} | 获利盘 ${(chip.profitRatio * 100).toFixed(0)}% | 90%集中度 ${chip.concentration90.toFixed(3)} | 峰位相对位置 ${chip.peakPos.toFixed(3)}(站上主峰为正) | 5日峰位漂移 ${chip.peakDrift.toFixed(3)}(下移=吸筹)`;
}

export interface TscorePromptInput {
  stockName: string;
  code: string;
  ctx: IntradayContext;
  indDaily: IndicatorResult;
  engineResults: RuleCheckResult[];
  chip: ChipDistribution | null;
  buyScore: number;
  sellScore: number;
  buyFactors: TFactorScore[];
  sellFactors: TFactorScore[];
  positionPercent?: number; // 未填=仓位未知（用户可能在场外持仓），仍算卖点
  marketNote: string;
}

export function buildTscoreUserPrompt(input: TscorePromptInput): string {
  const { stockName, code, ctx, indDaily, engineResults, chip, buyScore, sellScore, buyFactors, sellFactors, positionPercent, marketNote } = input;
  const lines: string[] = [];
  lines.push(`${marketNote}`);
  lines.push(`标的：${stockName} (${code})${positionPercent != null ? ` · 持仓占比 ${positionPercent}%` : ' · 仓位未填(可能在场外持仓)'}`);
  lines.push('');
  lines.push('## 盘中分时');
  lines.push(fmtIntraday(ctx));
  lines.push('');
  lines.push('## 日级技术');
  lines.push(fmtIndicators(indDaily));
  lines.push(fmtChip(chip));
  lines.push('');
  lines.push('## 预警引擎触发');
  lines.push(formatTriggeredRulesForAI(engineResults));
  lines.push('');
  lines.push('## 确定性因子分(已算好，你只需微调)');
  lines.push(`买入分 ${buyScore}：`);
  lines.push(fmtFactors(buyFactors));
  lines.push(`卖出分 ${sellScore}：`);
  lines.push(fmtFactors(sellFactors));
  lines.push('');
  lines.push('## 你的任务');
  lines.push('在 ±15 内给出 buy_adjust 与 sell_adjust，写 buy_reason 与 sell_reason、analysis、confidence、tags。只返回 JSON。');
  return lines.join('\n');
}
