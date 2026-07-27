/**
 * AI 筛选 — LLM 重排 prompt 构建
 *
 * prompt 模板译自 alphasift ranker.py:215-258，约束 LLM：
 * 不得推荐候选池外股票、不得修改硬筛条件、不得给目标价/承诺收益。
 * 文案用「筛选/排序」，避免荐股措辞（合规口径）。
 */

import type { AiPick, StrategyPreset } from './types';

const MAX_PROMPT_CHARS = 24000;

function fmt(n: number | null | undefined, digits = 2): string {
  if (n == null || Number.isNaN(n)) return '--';
  return n.toFixed(digits);
}

/** 单个候选的完整描述行 */
function candidateFull(k: AiPick): string {
  const fs = Object.entries(k.factorScores)
    .map(([k2, v]) => `${k2}:${v.toFixed(0)}`)
    .join(' ');
  return [
    `- ${k.tsCode} ${k.name}`,
    `  行业:${k.industry || '--'} 现价:${fmt(k.latestClose)} 涨跌:${fmt(k.latestChange)}% 成交额:${fmt(k.latestAmount, 0)}`,
    `  RPS:${fmt(k.rps, 1)} 60日涨幅:${fmt(k.ret60d)}% MACD:${k.macdStatus} RSI:${k.rsiStatus} 信号分:${fmt(k.signalScore, 0)}`,
    `  波动率:${fmt(k.volatility20d)}% 回撤:${fmt(k.maxDrawdown20d)}% ATR:${fmt(k.atr20)}% 量比:${fmt(k.volumeRatio)}`,
    `  ROE:${fmt(k.roe, 1)}% 毛利率:${fmt(k.grossprofitMargin, 1)}% 营收增速:${fmt(k.orYoy, 1)}% 行业指数涨幅:${fmt(k.industryChangePct)}%`,
    `  因子分:${fs} 规则总分:${fmt(k.screenScore, 1)}`,
  ].join('\n');
}

function candidateIdentity(k: AiPick): string {
  return `- ${k.tsCode} ${k.name} 规则总分:${fmt(k.screenScore, 1)} 行业:${k.industry || '--'}`;
}

/** 构建完整 prompt，超预算时按 identity→截断 优先级裁剪 */
export function buildRankingPrompt(picks: AiPick[], preset: StrategyPreset, context = ''): string {
  const hints = preset.rankingHints.trim() || '无额外排序提示。';
  const ctxText = context.trim() || '无额外上下文。只能基于候选池结构化数据和策略偏好判断。';

  const header = `你是一个专业的股票研究员，任务是在"已经由代码硬筛过"的候选池内做相对排序。
你不能推荐候选池外股票，不能修改硬筛条件，不能给目标价或承诺收益。你的价值在于：
1. 结合策略偏好，对候选之间做跨股票比较；
2. 识别结构化数据暴露不出的潜在催化、风格匹配和风险点；
3. 对行业/概念热度做语义归因，但不能把单日热度当作唯一买入理由；
4. 给出简短、可审计、可复核的排序理由。

## 排序依据
${hints}

## 市场/情报上下文
${ctxText}

## 候选列表（策略：${preset.name}）`;

  const footer = `\n## 输出要求
只返回 JSON，不要 Markdown，不要解释 JSON 以外的文本。
格式：
{
  "market_view": "一句话概括当前候选池和市场背景是否适合该策略",
  "selection_logic": "说明本次排序最主要的2-3个判断维度",
  "portfolio_risk": "说明最终名单可能存在的集中风险或共同风险",
  "ranked": [
    {
      "code": "股票代码",
      "llm_score": 0-100,
      "confidence": 0-1,
      "sector": "行业/主题短标签",
      "theme": "主要交易逻辑或主题",
      "thesis": "该候选入选的核心假设",
      "reason": "一句话排序理由",
      "risk": "一句话主要风险",
      "catalysts": ["潜在催化1"],
      "risk_flags": ["风险标签1"],
      "tags": ["趋势", "防守", "流动性"],
      "style_fit": "与策略风格的匹配度说明",
      "watch_items": ["后续应跟踪的数据或事件"],
      "invalidators": ["会推翻该候选逻辑的观察点"]
    }
  ]
}`;

  const fullLines = picks.map(candidateFull);
  const idLines = picks.map(candidateIdentity);

  // 先试 full
  let body = fullLines.join('\n');
  let trimmed = false;
  const fullPrompt = `${header}\n${body}\n${footer}`;
  if (fullPrompt.length <= MAX_PROMPT_CHARS) {
    return fullPrompt;
  }

  // 退回 identity，并按预算截断候选数
  trimmed = true;
  body = idLines.join('\n');
  let prompt = `${header}\n${body}\n${footer}`;
  if (prompt.length > MAX_PROMPT_CHARS) {
    // 逐个砍候选直到装得下
    let keep = idLines.length;
    while (keep > 1 && prompt.length > MAX_PROMPT_CHARS) {
      keep--;
      body = idLines.slice(0, keep).join('\n') + `\n...[prompt_trimmed]:candidate_omitted=${idLines.length - keep}`;
      prompt = `${header}\n${body}\n${footer}`;
    }
  }
  if (trimmed) prompt += '\n...[prompt_trimmed]:candidate_details';
  return prompt;
}
