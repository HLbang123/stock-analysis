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

/** 单个候选的完整描述行（瘦身版：删基本面3项/筹码4项/ATR——这些已压缩进 quality/chip 因子分，重复列出纯浪费 token） */
function candidateFull(k: AiPick): string {
  const fs = Object.entries(k.factorScores)
    .map(([k2, v]) => `${k2}:${v.toFixed(0)}`)
    .join(' ');
  return [
    `- ${k.tsCode} ${k.name}`,
    `  行业:${k.industry || '--'} 现价:${fmt(k.latestClose)} 涨跌:${fmt(k.latestChange)}% 成交额:${fmt(k.latestAmount, 0)}`,
    `  RPS:${fmt(k.rps, 1)} 60日涨幅:${fmt(k.ret60d)}% MACD:${k.macdStatus} RSI:${k.rsiStatus} 信号分:${fmt(k.signalScore, 0)}`,
    `  波动率:${fmt(k.volatility20d)}% 回撤:${fmt(k.maxDrawdown20d)}% 量比:${fmt(k.volumeRatio)} 因子分:${fs} 规则总分:${fmt(k.screenScore, 1)}`,
  ].join('\n');
}

function candidateIdentity(k: AiPick): string {
  return `- ${k.tsCode} ${k.name} 规则总分:${fmt(k.screenScore, 1)} 行业:${k.industry || '--'}`;
}

export interface AlreadyScoredRef {
  code: string;
  name: string;
  llmScore: number;
}

/**
 * 分片打分的共享上下文（08-11 起，ranker 把 topK 切成 10/片并行打分）：
 * - 静态分数带标尺：跨片分数同尺度的锚（替代旧版串行传 alreadyScored 的单一依赖，两者并存互补）
 * - 全池 identity 列表：本片只看到 10 只详情，identity 行保留跨股相对比较能力
 * 实验依据：思考型模型思考长度不随候选数缩减，50 一次喂必烧光预算；10/片+低思考 3/3 全绿
 */
export function buildShardPoolContext(pool: AiPick[]): string {
  const rubric = [
    '评分标尺（全池共用同一尺度，严格遵守）：',
    '90-100 = 多因子共振且板块催化明确；',
    '75-89 = 因子强、有催化但有个别瑕疵；',
    '60-74 = 中性偏上，缺乏突出亮点；',
    '40-59 = 有明显风险项或因子平庸；',
    '0-39 = 应当规避。',
  ].join('\n');
  const poolLines = pool.map(candidateIdentity).join('\n');
  return `${rubric}\n\n候选池总览（共 ${pool.length} 只，仅供相对比较参照，不要给它们打分；你只需给下方候选列表中的候选打分）：\n${poolLines}`;
}

/**
 * 构建完整 prompt，超预算时按 identity→截断 优先级裁剪。
 * alreadyScored 为增量续打模式：附已打分候选的分数分布，让 LLM 校准本次打分标尺
 * （历史请求与本次请求的分数保持同一尺度，避免标尺漂移扭曲最终排序）。
 */
export function buildRankingPrompt(
  picks: AiPick[],
  preset: StrategyPreset,
  context = '',
  alreadyScored: AlreadyScoredRef[] = [],
): string {
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

${alreadyScored.length > 0
  ? `## 已有 AI 打分（标尺参照）
以下候选此前已由 AI 打分（分数 0-100，含义与你要给的分完全一致）。请严格保持相同的评分标准，给本次候选打分时与之可比：
${alreadyScored.map((s) => `- ${s.code} ${s.name} ${s.llmScore.toFixed(0)}分`).join('\n')}

`
  : ''}## 候选列表（策略：${preset.name}）`;

  const footer = `\n## 输出要求
只返回 JSON，不要 Markdown，不要解释 JSON 以外的文本。
**ranked 数组必须包含上方候选列表的全部候选——每个 code 必须与候选列表一致，不得遗漏任何一个，不得编造候选池外的代码。若候选有 N 个，ranked 数组长度必须为 N。**
**散文字段（thesis/reason/risk）每项 ≤20 字；数组字段（catalysts/risk_flags/tags/watch_items/invalidators）每项最多 1 个、每个 ≤8 字。输出越精炼越好。**
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
      "thesis": "该候选入选的核心假设",
      "reason": "一句话排序理由",
      "risk": "一句话主要风险",
      "catalysts": ["潜在催化1"],
      "risk_flags": ["风险标签1"],
      "tags": ["标签1（可选）"],
      "watch_items": ["观察项1（可选，后续要跟踪什么）"],
      "invalidators": ["证伪点1（可选，出现什么条件说明判断失效）"]
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
