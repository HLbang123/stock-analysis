'use client';

import { useCallback, useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { useAiStore } from '@/store/ai-store';
import { chatCompletionDirect } from '@/services/llm/browser-client';
import { NARRATE_PROMPT, compactEvidence, parseJsonLoose, toNarrative } from '@/services/thesis/narrate-prompt';

/**
 * 论点驱动选股 tab
 *
 * 从一条信息出发（一次异动 / 一次公告 / 你的一个想法）→ 层层展开 → 同时反证 → 你拍板。
 * 数据来自 /api/thesis（thesis_cards / thesis_seeds）。
 *
 * 🔴 成本约定（2026-09-14）：**服务器不为用户的想法花任何模型额度。**
 *   本组件把流程拆成三步：① POST resolve → 服务器做纯 SQL 的证据采集（零成本）；
 *   ② 浏览器用**用户自己在设置里配的模型**直连生成研判文字；③ POST save → 服务器只落库。
 *   用户没配模型 / 调用失败 → 自动降级为服务器整理的证据 + 模板叙述，功能不中断。
 *
 * 文案约束（docs/memory/ui-copy-compliance.md）：不出现「股」字、不解释实现细节。
 */

const KIND_LABEL: Record<string, string> = {
  d1_boom: '业绩聚集',
  d2_theme: '题材聚集',
  d3_flow: '资金异动',
  idea: '你的想法',
};

const VERDICTS = [
  { v: 'buy', label: '值得下手', cls: 'bg-red-600 text-white hover:bg-red-700' },
  { v: 'watch', label: '先观察', cls: 'bg-amber-500 text-white hover:bg-amber-600' },
  { v: 'skip', label: '放弃', cls: 'bg-gray-400 text-white hover:bg-gray-500' },
] as const;

/** 浏览器匿名 id：只用于统计「几人独立提出」，不是身份，也不做安全边界 */
function getAnonId(): string {
  if (typeof window === 'undefined') return '';
  let id = window.localStorage.getItem('thesis-anon-id');
  if (!id) {
    id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    window.localStorage.setItem('thesis-anon-id', id);
  }
  return id;
}

const pct = (v: number | null | undefined, d = 2) =>
  v == null || Number.isNaN(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`;
const tone = (v: number | null | undefined) =>
  v == null || Number.isNaN(v) ? 'text-gray-400'
    : v > 0 ? 'text-red-600 dark:text-red-400'
    : v < 0 ? 'text-green-600 dark:text-green-400' : 'text-gray-500';

export function ThesisTab() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<'cards' | 'wall' | 'review'>('cards');
  const [idea, setIdea] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [expanded, setExpanded] = useState<number | null>(null);
  const profiles = useAiStore((s) => s.profiles);
  const currentProfileId = useAiStore((s) => s.currentProfileId);
  const profile = profiles.find((p) => p.id === currentProfileId) ?? profiles[0] ?? null;

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const res = await fetch('/api/thesis?days=120');
      const j = await res.json();
      if (j.error) throw new Error(j.error);
      setData(j);
    } catch (e: any) { setErr(String(e.message ?? e)); setData(null); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const submitIdea = async () => {
    const text = idea.trim();
    if (text.length < 2) return;
    setBusy('idea'); setErr(null);
    try {
      // ① 服务器：想法 → 板块 → 证据（纯 SQL，零模型成本）
      const res = await fetch('/api/thesis', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resolve', idea: text, anonId: getAnonId() }),
      });
      const r = await res.json();
      if (r.error) throw new Error(r.error);

      // ② 浏览器：用**用户自己的模型**生成研判；拿不到就退回服务器给的模板
      let narrative = { ...r.template, llmUsed: false };
      let narratedBy = 'template';
      if (profile && (profile.baseUrl || profile.apiKey)) {
        try {
          const { content } = await chatCompletionDirect({
            baseUrl: profile.baseUrl, apiKey: profile.apiKey, model: profile.model,
            messages: [
              { role: 'system', content: NARRATE_PROMPT },
              { role: 'user', content: JSON.stringify(compactEvidence(r.evidence)) },
            ],
            // 思考型模型：思考与正文共用这个预算，卡太紧会正文为空（见 services/ai-screen/ranker.ts）
            temperature: 0.3, maxTokens: 8192, timeoutMs: 120_000,
          });
          const n = toNarrative(parseJsonLoose(content), r.template);
          if (n) { narrative = n; narratedBy = 'user-llm'; }
          else setErr('模型没有给出反面证据，卡片按纪律降级为系统整理的证据');
        } catch (e: any) {
          setErr('你配置的模型调用失败，已降级为系统整理的证据：' + String(e.message ?? e).slice(0, 60));
        }
      } else {
        setErr('还没有配置自己的模型，先用系统整理的证据。配置后可由你自己的模型生成研判。');
      }

      // ③ 服务器：只落库，不碰模型
      const res2 = await fetch('/api/thesis', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'save', subject: r.subject, subjectCode: r.subjectCode, asOf: r.asOf,
          kind: 'idea', metric: { idea: text, to: r.asOf },
          evidence: r.evidence, narrative, narratedBy,
        }),
      });
      const j2 = await res2.json();
      if (j2.error) throw new Error(j2.error);
      setIdea(''); await load(); setExpanded(j2.cardId ?? null);
      if (r.proposers > 1) setErr(`这条线索已有 ${r.proposers} 人独立提出 —— 共识度是参考，不是证据`);
    } catch (e: any) { setErr(String(e.message ?? e)); }
    finally { setBusy(null); }
  };

  const judge = async (cardId: number, verdict: string) => {
    if (verdict !== 'skip' && !note.trim()) {
      setErr('拍板要写下理由——这是事后校准的唯一依据');
      return;
    }
    setBusy(`v${cardId}`); setErr(null);
    try {
      const res = await fetch('/api/thesis', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'verdict', cardId, verdict, note: note.trim() }),
      });
      const j = await res.json();
      if (j.error) throw new Error(j.error);
      setNote(''); await load();
    } catch (e: any) { setErr(String(e.message ?? e)); }
    finally { setBusy(null); }
  };

  if (loading) return <div className="py-16 text-center text-sm text-gray-400">加载中…</div>;
  if (!data?.ready)
    return (
      <div className="py-16 text-center text-sm text-gray-400">
        还没有数据。先跑一次 <code className="px-1 bg-gray-100 dark:bg-gray-800 rounded">scripts/thesis-setup.sql</code>。
      </div>
    );

  const cards = mode === 'cards' ? (data.cards ?? []) : (data.review ?? []);
  const wall = data.wall ?? [];

  return (
    <div className="space-y-4">
      {/* 从一个想法出发 */}
      <div className="p-4 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
        <div className="text-sm font-medium mb-2">从一个想法出发</div>
        <div className="flex gap-2">
          <input
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submitIdea()}
            placeholder="例如：MLCC 涨价 / 固态电池 / 半导体设备国产替代"
            className="flex-1 px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent focus:outline-none focus:border-gray-400"
          />
          <button
            onClick={submitIdea}
            disabled={busy === 'idea' || idea.trim().length < 2}
            className={cn('px-4 py-2 text-sm rounded-lg text-white transition',
              busy === 'idea' || idea.trim().length < 2 ? 'bg-gray-300 cursor-not-allowed' : 'bg-gray-900 hover:bg-gray-700 dark:bg-white dark:text-gray-900')}
          >
            {busy === 'idea' ? '调查中…' : '由点及面'}
          </button>
        </div>
        <p className="text-xs text-gray-400 mt-2">
          系统会把它落到具体板块、摆出证据，并**先替你反证**。
          {profile
            ? `研判文字由你配置的「${profile.model || '模型'}」生成，不消耗本站资源。`
            : '你还没有配置自己的模型 —— 现在只出证据、不出研判文字。到设置里配一个即可。'}
        </p>
      </div>

      {err && <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 text-xs text-amber-700 dark:text-amber-400">{err}</div>}

      {/* 模式切换 */}
      <div className="flex items-center gap-1 p-1 bg-gray-100 dark:bg-gray-800 rounded-lg w-fit">
        {([['cards', `论点卡 ${data.stats?.totalCards ?? 0}`],
           ['wall', `线索墙 ${(data.wall ?? []).length}`],
           ['review', `复盘 ${data.stats?.reviewN ?? 0}`]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setMode(k)}
            className={cn('px-4 py-1.5 rounded-md text-sm transition',
              mode === k ? 'bg-white dark:bg-gray-900 shadow-sm font-medium' : 'text-gray-500 hover:text-gray-700')}>
            {label}
          </button>
        ))}
      </div>

      {mode === 'review' && (
        <div className="p-4 rounded-xl border border-gray-200 dark:border-gray-800 text-xs text-gray-500 space-y-1">
          <div>复盘看的不是胜率，是**哪一类理由事后被证明是系统性错的**。</div>
          {data.stats?.reviewEx20 != null && (
            <div>已到期 {data.stats.reviewN} 张 · 候选等权 T+20 超额 <span className={tone(data.stats.reviewEx20)}>{pct(data.stats.reviewEx20)}</span>（仅供参考，样本极小）</div>
          )}
        </div>
      )}

      {/* 线索墙：用户提交的想法（强制公开）。按「几人独立提出」排序 —— 共识度是参考，不是证据 */}
      {mode === 'wall' && (
        <>
          <div className="p-3 rounded-xl border border-gray-200 dark:border-gray-800 text-xs text-gray-500 leading-relaxed">
            这里汇集所有人提交的调查线索。**多人独立想到同一件事，本身有信息量**，但不代表它是对的 ——
            每条线索都带反面证据，请自己判断。提交的内容对所有使用者可见。
          </div>
          {wall.length === 0 ? (
            <div className="py-16 text-center text-sm text-gray-400">
              还没有人提交线索。在上面的框里写下你的想法，它会同步给所有人。
            </div>
          ) : (
            wall.map((w: any) => (
              <div key={w.subject} className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2 flex-wrap min-w-0">
                    <span className="font-medium">{w.subject}</span>
                    {w.proposers > 1 && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-purple-100 dark:bg-purple-950/40 text-purple-700 dark:text-purple-300">
                        {w.proposers} 人提出
                      </span>
                    )}
                    {!w.card?.thesis && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500">待研判</span>
                    )}
                    {w.card?.narratedBy === 'server' && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500">系统研判</span>
                    )}
                  </div>
                  <span className="text-xs text-gray-400 shrink-0">
                    {typeof w.lastAt === 'string' ? w.lastAt.slice(0, 10) : ''}
                  </span>
                </div>

                {w.ideas?.length > 0 && (
                  <div className="text-xs text-gray-500">
                    原话：{w.ideas.map((t: string, i: number) => (
                      <span key={i} className="mr-2 px-1.5 py-0.5 rounded bg-gray-50 dark:bg-gray-800">「{t}」</span>
                    ))}
                  </div>
                )}

                {w.card?.thesis ? (
                  <div className="space-y-1.5 text-sm pt-1">
                    <div className="text-gray-700 dark:text-gray-300">{w.card.thesis}</div>
                    {w.card.mispricing && (
                      <div className="text-xs text-gray-500">错价假设：{w.card.mispricing}</div>
                    )}
                    <div className="text-xs text-gray-600 dark:text-gray-400">
                      <span className="text-gray-400">🔴 反面证据：</span>{w.card.counter}
                    </div>
                  </div>
                ) : (
                  <div className="text-xs text-gray-400 pt-1">
                    还没有研判。你可以在上面输入同样的方向，用自己的模型补一份 —— 补完所有人都能看到。
                  </div>
                )}
              </div>
            ))
          )}
        </>
      )}

      {mode !== 'wall' && cards.length === 0 && (
        <div className="py-16 text-center text-sm text-gray-400">
          {mode === 'review' ? '还没有到期可复盘的卡片（需要卡龄 ≥ 20 个交易日）' : '还没有论点卡。系统不是每天都有论点——这是正常的。'}
        </div>
      )}

      {cards.map((c: any) => {
        const en = c.enrichment;
        const open = expanded === c.cardId;
        const f = c.forward;
        return (
          <div key={c.cardId} className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden">
            <div className="p-4 cursor-pointer" onClick={() => setExpanded(open ? null : c.cardId)}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400">
                      {KIND_LABEL[c.kind] ?? c.kind}
                    </span>
                    <span className="font-medium">{c.subject}</span>
                    <span className="text-xs text-gray-400">{c.cardDate}</span>
                    {c.verdict && (
                      <span className={cn('text-xs px-1.5 py-0.5 rounded',
                        c.verdict === 'buy' ? 'bg-red-100 text-red-700' : c.verdict === 'watch' ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-500')}>
                        {VERDICTS.find((v) => v.v === c.verdict)?.label}
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-gray-700 dark:text-gray-300 mt-1.5">{c.thesis}</div>
                </div>
                <div className="text-right shrink-0">
                  {en && <div className="text-xs text-gray-400">富集 <span className="font-mono text-gray-700 dark:text-gray-200">{en.enrich}x</span></div>}
                  {f?.t20 && <div className={cn('text-xs font-mono', tone(f.t20.ex))}>T+20 {pct(f.t20.ex)}</div>}
                </div>
              </div>
            </div>

            {open && (
              <div className="px-4 pb-4 border-t border-gray-100 dark:border-gray-800 pt-3 space-y-3 text-sm">
                <Section label="错价假设" text={c.mispricing} />
                <div>
                  <div className="text-xs text-gray-400 mb-1">🔴 反面证据</div>
                  <div className="text-gray-700 dark:text-gray-300 whitespace-pre-wrap">{c.counter}</div>
                </div>
                {c.triggers?.length > 0 && (
                  <div>
                    <div className="text-xs text-gray-400 mb-1">后续盯什么</div>
                    <ul className="list-disc list-inside text-gray-600 dark:text-gray-400 space-y-0.5">
                      {c.triggers.map((t: string, i: number) => <li key={i}>{t}</li>)}
                    </ul>
                  </div>
                )}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                  {c.board && <Metric label="板块 20 日" value={pct(c.board.ret20)} tone={tone(c.board.ret20)} />}
                  {c.board && <Metric label="板块 60 日" value={pct(c.board.ret60)} tone={tone(c.board.ret60)} />}
                  {en && <Metric label="命中/成分" value={en.x + "/" + en.k} />}
                  {c.contrad?.lossMaking != null && (
                    <Metric label="同板块负面预告" value={c.contrad.lossMaking + " 家"} tone={c.contrad.lossMaking > 0 ? 'text-amber-600' : undefined} />
                  )}
                </div>
                {c.candidates?.length > 0 && (
                  <div>
                    <div className="text-xs text-gray-400 mb-1">待调查清单（不是推荐）</div>
                    <div className="flex flex-wrap gap-1.5">
                      {c.candidates.slice(0, 15).map((m: any) => (
                        <span key={m.ts_code} className="text-xs px-2 py-0.5 rounded bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700">
                          {m.name || m.ts_code}
                          <span className={cn('ml-1 font-mono', tone(m.pct20))}>{pct(m.pct20, 1)}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {!c.verdict ? (
                  <div className="pt-2 border-t border-gray-100 dark:border-gray-800 space-y-2">
                    <input
                      value={note} onChange={(e) => setNote(e.target.value)}
                      placeholder="你的理由（会写死，事后不改——这是复盘校准的唯一依据）"
                      className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent focus:outline-none focus:border-gray-400"
                    />
                    <div className="flex gap-2">
                      {VERDICTS.map((v) => (
                        <button key={v.v} onClick={() => judge(c.cardId, v.v)} disabled={busy === 'v' + c.cardId}
                          className={cn('px-3 py-1.5 text-xs rounded-lg transition', v.cls)}>
                          {v.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="pt-2 border-t border-gray-100 dark:border-gray-800 text-xs text-gray-500">
                    你的理由：{c.verdictNote || '（未填）'}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Section({ label, text }: { label: string; text?: string | null }) {
  if (!text) return null;
  return (
    <div>
      <div className="text-xs text-gray-400 mb-1">{label}</div>
      <div className="text-gray-700 dark:text-gray-300 whitespace-pre-wrap">{text}</div>
    </div>
  );
}

function Metric({ label, value, tone: t }: { label: string; value: string; tone?: string }) {
  return (
    <div className="p-2 rounded-lg bg-gray-50 dark:bg-gray-800/50">
      <div className="text-gray-400">{label}</div>
      <div className={cn('font-mono mt-0.5', t ?? 'text-gray-700 dark:text-gray-200')}>{value}</div>
    </div>
  );
}
