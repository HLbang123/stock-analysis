/**
 * 深度分析 Prompt — 提取自 TradingAgents-CN 多智能体协作架构
 * 三阶段：情报收集 → 多空辩论（两轮） → 最终裁决
 */

import { AiAnalysisRecord } from '@/store/ai-store';

// 17条规则速查表（阶段一引用）
const RULES_TABLE = `| ID | 名称 | 条件 | 级别 |
|----|------|------|------|
| R001 | 巨量预警 | 量>5日均量×1.25 | WARNING |
| R002 | 巨量见顶 | 量≥年最大×0.95 或 >5日最高×1.2 | WARNING |
| R003 | 长上影线 | 上影>3%+前急拉>3%+涨速放缓2% | WARNING |
| R004 | 破五日线 | 收<MA5 且 量>前日×1.1 | CRITICAL |
| R005 | 破趋势线 | 连续2日收<10日低点均线+放量×1.05 | CRITICAL |
| R006 | 超大阳线 | 涨幅>5.5% | WARNING |
| R007 | 连阳预警 | 连2天涨3%-5.5% 或 连3阳 | WARNING |
| R008 | 妇联定律 | 工业富联sh601138涨>8%→科技股警惕 | WARNING |
| R009 | 二波见顶 | 近10日最高量≥历史最高×0.9 | WARNING |
| R010 | 急跌预警 | 跌幅>7% | CRITICAL |
| R011 | 反包入场 | 15日回调>5%+涨≥5%+收>98%近期高 | INFO |
| R012 | 箱体吸筹 | 60日振幅<20%+涨1%-4%+量>20日均×1.3 | INFO |
| R013 | 缩量破位 | 收<MA5+量<前日×0.9 | WARNING |
| R014 | 对子顶 | 连续2日高/收≈+上影>2.5%+放量×1.2 | CRITICAL |
| R015 | 止跌企稳 | 近15日新低附近+长下影>2%或十字星 | INFO |
| R016 | 黄金反弹 | 回调至0.382-0.618+涨>3%+放量×1.2 | INFO |
| R017 | 横盘滞涨 | 5日振幅<5%+累涨<2% | WARNING |`;

// ============ 阶段一：情报收集 ============

export function buildAnalystSystemPrompt(isETF?: boolean): string {
  const fundamentalSection = isETF
    ? `### ETF 专项分析
（分析跟踪指数的趋势和关键位置、当前市场的风格偏好、板块资金流向、ETF 规模流动性、折溢价水平。100-200字）`
    : `### 基本面评估
（基于数据推测估值水平、行业地位、盈利能力、成长性。100-200字）`;

  const etfNote = isETF
    ? `\n- 此标的为 ETF，不做个股基本面分析，聚焦指数趋势和板块轮动`
    : '';

  return `你是资深A股市场分析师，拥有10年以上的技术分析和基本面研究经验。请基于提供的股票数据，输出一份结构化的深度分析师报告。

## 报告格式（严格遵守）

### 技术面分析
（分析K线形态、均线系统、MACD/RSI等指标、成交量变化、支撑压力位、短期及中期趋势判断。200-300字）

${fundamentalSection}

### 市场环境
（大盘氛围、所属板块热度、资金流向分析、近期市场情绪。100-200字）

### 关键风险点
（列出3-5个具体风险，每条以"- "开头，需具体说明风险来源和可能影响。100-150字）

## 参考规则速查表（引擎已用这些规则做了初判，供你参考）

${RULES_TABLE}

注意：
- 分析必须基于实际数据，不能凭空猜测
- 使用中文，语言专业但易懂
- 技术指标需引用具体数值
- 如果有历史分析回顾，需要评估上次判断的准确性并说明变化因素${etfNote}`;
}

export function buildAnalystUserPrompt(
  stockCode: string,
  stockName: string,
  quoteJson: string,
  klineSummary: string,
  engineResults: string,
  indicatorBlock?: string,
  reflectionBlock?: string,
  positionNote?: string,
  isETF?: boolean
): string {
  const indicatorSection = indicatorBlock ? `${indicatorBlock}\n` : '';
  const reflectionSection = reflectionBlock ? `${reflectionBlock}\n` : '';
  const positionSection = positionNote ? `${positionNote}\n` : '';
  const etfNote = isETF ? '⚠️ 此为 ETF，请聚焦指数趋势、资金流向和板块轮动，不需要分析个股基本面。\n' : '';
  return `分析股票：${stockName} (${stockCode})
${etfNote}${reflectionSection}${positionSection}
实时行情：
${quoteJson}

${indicatorSection}
近60日K线（日期 开 高 低 收 量）：
${klineSummary}

引擎初判（参考，17条规则检测结果）：${engineResults}`;
}

// ============ 阶段二：多空辩论 ============

/** 第一轮：多方初始论点 + 空方初始论点 */
export function buildDebateRound1SystemPrompt(): string {
  return `你是投资辩论主持人。请依次扮演多方研究员和空方研究员，进行第一轮辩论。

## 第一轮

### 多方研究员（看涨论点）
以"【多方观点】"开头，列出3-5个看涨理由：
- 每个理由必须有具体数据支撑（价格、成交量、均线位置、技术指标等）
- 分析上涨的催化剂和潜在空间
- 200-300字

### 空方研究员（看跌论点）
以"【空方观点】"开头，列出3-5个看跌理由：
- 直接针对多方提出的论点进行质疑
- 指出被多方忽视的负面因素
- 同样需要数据支撑
- 200-300字

注意：严格遵守角色切换，不要混淆身份。`;
}

/** 第二轮：多方反驳 + 空方反驳 + 研究经理综合评判 */
export function buildDebateRound2SystemPrompt(): string {
  return `你是投资辩论主持人。基于第一轮双方的初始论点，现在进入第二轮深度辩论。

## 第二轮

### 多方反驳
以"【多方反驳】"开头：
- 针对空方第一轮的每个质疑，逐一进行反驳
- 补充新的看涨证据
- 强调空方逻辑中的漏洞或忽视的利好因素
- 150-250字

### 空方反驳
以"【空方反驳】"开头：
- 针对多方第一轮的每个论点，逐一进行质疑
- 补充新的看跌证据
- 强调多方逻辑中的风险盲点
- 150-250字

### 研究经理综合评判
以"【综合评判】"开头：
- 客观权衡双方两轮论点的说服力
- 点出市场最关心的核心矛盾
- 给出偏向性判断：偏多 / 偏空 / 中性
- 说明做出这个判断的关键依据
- 150-250字

注意：严格遵守角色切换。`;
}

export function buildDebateRound2UserPrompt(
  stockCode: string,
  stockName: string,
  round1Output: string,
  quoteJson: string
): string {
  return `股票：${stockName} (${stockCode})

当前行情参考：
${quoteJson}

以下为第一轮多空辩论的完整记录：

${round1Output}

请基于第一轮辩论内容，进行第二轮反驳和综合评判。`;
}

// 保持旧接口兼容（用于快速分析场景，不参与深度分析的辩论）
export function buildDebateUserPrompt(
  stockCode: string,
  stockName: string,
  stage1Output: string,
  quoteJson: string,
  indicatorBlock?: string
): string {
  const indicatorSection = indicatorBlock ? `${indicatorBlock}\n` : '';
  return `股票：${stockName} (${stockCode})

当前行情参考：
${quoteJson}

${indicatorSection}
以下是一份深度分析师报告，请基于这份报告进行多空辩论：

${stage1Output}`;
}

/** @deprecated 保留用于客户端回退，深度分析使用 buildDebateRound1SystemPrompt */
export function buildDebateSystemPrompt(): string {
  return buildDebateRound1SystemPrompt();
}

// ============ 阶段三：最终裁决 ============

export function buildVerdictSystemPrompt(): string {
  return `你是首席风险管理官，拥有20年A股投资和风控经验。基于前期的分析师报告和多空辩论结果，你需要做出最终的投资决策。

## 决策格式（严格遵守，每行一个字段）

ACTION:（买入/持有/卖出，三选一，必须用中文）
RISK_LEVEL:（高风险/中风险/低风险，三选一）
CONFIDENCE:（0-100的整数，60以上才算有信心）
CONFIDENCE_SCORE:（0-1之间的浮点数，如0.75表示75%的信心，保留两位小数）
TARGET_LOW:（目标价下限，仅数字，如10.50）
TARGET_HIGH:（目标价上限，仅数字，如12.80）
STOP_LOSS:（止损价，仅数字，如9.20）
POSITION:（建议仓位百分比，如20%、50%、80%，含%符号）
KEY_POINTS:（用 | 分隔的关键要点，如：1. MACD金叉多头动能充足 | 2. 成交量温和放大突破有效 | 3. 上方120日均线构成压力需保守）

---
### 决策理由
（综合技术面、基本面、辩论结果，说明为什么做出这个决策。200-300字）

### 操作计划
（具体的操作步骤，包括建仓时机、加仓条件、减仓条件、时间节点。100-200字）

### 风险提示
（最重要的1-3个风险提示，说明可能出现的最坏情况。100-150字）

注意：
- ACTION只能是"买入""持有""卖出"之一
- 所有价格必须基于提供的行情数据合理推算
- 决策要体现风控意识，不能激进`;
}

export function buildVerdictUserPrompt(
  stockCode: string,
  stockName: string,
  stage1Output: string,
  stage2Output: string,
  quoteJson: string,
  positionNote?: string
): string {
  const positionSection = positionNote ? `${positionNote}\n` : '';
  return `股票：${stockName} (${stockCode})

**当前实时行情（务必以此为准）**：
${quoteJson}
${positionSection}
## 分析师报告
${stage1Output}

## 多空辩论
${stage2Output || '(辩论环节跳过)'}

请基于以上信息，做出最终投资决策。**注意：目标价和止损价必须参考上方实时行情中的当前价格。**`;
}

// ============ 反思/记忆机制 ============

/**
 * 从历史记录构建反思上下文。
 * 返回空字符串表示无可用历史。
 */
export function buildReflectionContext(
  stockCode: string,
  history: AiAnalysisRecord[],
  currentQuote: { price: number; changePercent: number }
): string {
  const recentRecords = history
    .filter(r => r.stockCode === stockCode)
    .sort((a, b) => b.createdAt - a.createdAt);

  if (recentRecords.length === 0) return '';

  const latest = recentRecords[0];
  const timeStr = new Date(latest.createdAt).toLocaleString('zh-CN');

  let summary = `时间：${timeStr}\n模型：${latest.model}\n风险等级：${latest.riskLevel}`;
  summary += `\n历史建议：${latest.suggestion}`;
  summary += `\n历史分析摘要：${latest.analysis.slice(0, 300)}`;

  if (latest.suggestion?.includes('买入') || latest.riskLevel?.includes('买入')) {
    summary += `\n注意：该股票上次分析时给出"买入"建议，请结合当前价格${currentQuote.price}（涨跌${currentQuote.changePercent.toFixed(2)}%）评估上次建议的准确性。`;
  }

  return `## 历史分析回顾
${summary}

请结合当前情况，评估上次判断的准确性，并说明哪些因素发生了变化。`;
}
