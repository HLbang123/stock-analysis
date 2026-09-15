/**
 * 每日推荐的 LLM 叙述
 *
 * 选股本身是纯规则的（论点板块 + 筛选条件），**这里才是「论点的选股思想」真正落地的地方**：
 * 让模型看着「板块为什么异动 + 这只票自己的位置」，写出**推荐理由**和**反面证据**。
 *
 * 成本：**一天一次调用**（整个列表一起给模型），不是每只一次。
 * 可降级：没有 key 或调用失败 → 返回空 Map，前端回落到规则模板文案（不阻断落库）。
 */
import { buildChatUrl, buildLLMHeaders } from '@/lib/llm/shared';
import type { DailyResult } from './daily';

/** 反证缺失视为无效 —— 与 ThesisCard 的同一条军规（没有反证的观点不予呈现） */
export interface PickNote {
  thesis: string;
  counter: string;
}

const SYS_PROMPT = `你是研究助理。下面是今天挑出的候选标的，部分标的还带有「所属板块」及其异动情况。

请为每一只候选写两句话：
- thesis：为什么它值得看。**有板块信息的，把板块异动和它自己的位置连起来；没有板块信息的，只从它自身的量价状态写**（跌幅深度、近一周跌速、成交活跃度变化），**不要编造板块或行业归属，也不要写「所属板块未标注」这类废话**。
- counter：一条反面证据 —— 什么情况下这个判断是错的（同样是针对你自己写的理由，而不是套话）

硬性要求：
1. 不得出现「买入 / 卖出 / 推荐 / 加仓 / 减仓 / 目标价 / 必涨 / 稳赚」等词；
2. 只陈述事实与推断，不做任何承诺；
3. 每句不超过 60 字，中文；
4. 只输出 JSON 数组，不要任何解释文字，形如：
   [{"code":"600895","thesis":"...","counter":"..."}]`;

interface LlmCfg { baseUrl: string; apiKey: string; model: string }

function getCfg(): LlmCfg | null {
  const apiKey = process.env.THESIS_API_KEY || process.env.AI_SCREEN_API_KEY;
  if (!apiKey) return null;
  return {
    baseUrl: process.env.THESIS_BASE_URL || process.env.AI_SCREEN_BASE_URL || 'https://api.deepseek.com',
    apiKey,
    model: process.env.THESIS_MODEL || process.env.AI_SCREEN_MODEL || 'deepseek-v4-flash',
  };
}

/** 服务器是否配了模型 key */
export function hasServerLlm(): boolean {
  return !!getCfg();
}

function timeout(ms: number) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, clear: () => clearTimeout(t) };
}

/** 宽松解析：模型常把 JSON 包在 ```json 里或前后带话 */
function parseJsonLoose(raw: string): any[] | null {
  if (!raw) return null;
  const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  const i = cleaned.indexOf('[');
  const j = cleaned.lastIndexOf(']');
  if (i < 0 || j <= i) return null;
  try {
    const arr = JSON.parse(cleaned.slice(i, j + 1));
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

/**
 * 给整份推荐写理由与反证。返回 code(6 位) -> PickNote。
 * 失败/无 key → 返回空 Map（调用方回落到模板文案）。
 */
export async function narratePicks(r: DailyResult): Promise<Map<string, PickNote>> {
  const out = new Map<string, PickNote>();
  const cfg = getCfg();
  if (!cfg || !r.picks.length) return out;

  const payload = {
    asOf: r.asOf,
    板块: r.boards.map((b) => ({ 名称: b.name, 异动: b.reason })),
    候选: r.picks.map((p) => ({
      code: p.tsCode.split('.')[0],
      名称: p.name,
      所属板块: p.boardName,
      板块异动: p.boardReason,
      近20日涨跌: p.past20 == null ? null : `${p.past20.toFixed(1)}%`,
      成交活跃度分档: p.turnoverQ,
    })),
  };

  try {
    const { signal, clear } = timeout(120_000);
    const res = await fetch(buildChatUrl(cfg.baseUrl), {
      method: 'POST',
      headers: buildLLMHeaders(cfg.apiKey),
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: SYS_PROMPT },
          { role: 'user', content: JSON.stringify(payload) },
        ],
        temperature: 0.3,
        // 思考型模型的 max_tokens = 思考 + 正文总预算（见 services/ai-screen/ranker.ts 的教训）
        max_tokens: 8192,
        stream: false,
      }),
      signal,
    });
    clear();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: any = await res.json();
    const raw: string = data?.choices?.[0]?.message?.content ?? '';
    const arr = parseJsonLoose(raw);
    if (!arr) throw new Error('模型输出无法解析为 JSON 数组');

    for (const it of arr) {
      const code = String(it?.code ?? '').split('.')[0];
      const thesis = String(it?.thesis ?? '').trim();
      const counter = String(it?.counter ?? '').trim();
      // 🔴 反证缺失 → 这条不予采用（同 ThesisCard：没有反面证据的观点不呈现）
      if (code && thesis && counter) out.set(code, { thesis, counter });
    }
    console.log(`[picks] 模型叙述 ${out.size}/${r.picks.length} 条`);
  } catch (e: any) {
    console.warn(`[picks] 模型叙述失败，回落规则文案：${String(e?.message).slice(0, 120)}`);
  }
  return out;
}
