/**
 * 论点叙述：提示词与解析（**纯函数，无任何服务端依赖**）
 *
 * 单独放一个文件的原因：浏览器要复用同一套提示词（用户用自己的 key 直连模型），
 * 而 investigate.ts 依赖 prisma —— 客户端组件一旦 import 它就会把 prisma 打进 bundle。
 * 这里只放纯函数，前后端都能安全引用，且提示词保持**单一事实源**。
 */

export interface EvidenceLike {
  subject: string;
  asOf: string;
  kind: string;
  concept?: { members: number; listed: any[] } | null;
  fundamentals?: { hits: any[]; recent: any[] } | null;
  board?: any;
  enrichment?: any;
  flow?: any;
  contradicting?: any;
}

export interface NarrativeLike {
  thesis: string;
  mispricing: string;
  counter: string;
  triggers: string[];
  llmUsed: boolean;
}

export const NARRATE_PROMPT = `你是一名 A 股产业研究员。下面是系统为一个「论点起点」采集的**原始证据**。
请完成三件事，输出严格 JSON：

{
  "thesis": "一句话论点：什么正在发生（不超过 60 字）",
  "mispricing": "错价假设：市场为什么还没充分反映它（不超过 100 字）",
  "counter": "🔴 反面证据：什么情况下这个论点是错的？必须基于下方证据中的具体数字，不许写空话（不超过 120 字）",
  "triggers": ["后续需要盯的 2~4 个可验证事项"]
}

硬性要求：
1. **counter 必须写，且必须引用证据里的具体数字**。如果你找不到任何反面证据，写「无反面证据」并说明为什么——但不许编造。
2. 不许推荐买入，不许给目标价。你只负责把证据讲成一个可被证伪的判断。
3. 只依据给定证据，不许补充证据里没有的行业知识。`;

/** 只把证据里最相关的部分喂给模型，控制 token */
export function compactEvidence(ev: EvidenceLike) {
  const movers = (ev.concept?.listed ?? [])
    .slice()
    .sort((a: any, b: any) => (b.pct20 ?? -999) - (a.pct20 ?? -999))
    .slice(0, 12)
    .map((m: any) => ({ code: m.ts_code, name: m.name, pct1: m.pct1, pct5: m.pct5, pct20: m.pct20 }));
  return {
    起点类型: ev.kind,
    标的: ev.subject,
    日期: ev.asOf,
    概念成分数: ev.concept?.members ?? null,
    涨幅前12成分: movers,
    基本面命中: ev.fundamentals?.hits ?? [],
    该概念近期其他预告: ev.fundamentals?.recent?.slice(0, 10) ?? [],
    板块走势: ev.board ?? null,
    资金流: ev.flow ?? null,
    反向数据: ev.contradicting ?? null,
  };
}

/** 容错 JSON 解析（去 ```json 包裹、取平衡子串） */
export function parseJsonLoose(raw: string): any | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  for (const c of [fenced?.[1], raw]) {
    if (!c) continue;
    const m = c.match(/\{[\s\S]*\}/);
    if (!m) continue;
    try { return JSON.parse(m[0]); } catch { /* next */ }
  }
  return null;
}

/** 把模型输出规整成 NarrativeLike；缺 counter 视为无效（返回 null） */
export function toNarrative(parsed: any, fallback: NarrativeLike): NarrativeLike | null {
  if (!parsed?.thesis) return null;
  const counter = String(parsed.counter ?? '').trim();
  if (!counter) return null; // 🔴 反面证据缺失 → 这张卡无效
  return {
    thesis: String(parsed.thesis),
    mispricing: String(parsed.mispricing ?? fallback.mispricing ?? ''),
    counter,
    triggers: Array.isArray(parsed.triggers) ? parsed.triggers.map(String).slice(0, 4) : [],
    llmUsed: true,
  };
}
