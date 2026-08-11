'use client';

/**
 * 本周回顾(纯内容组件) — 复盘弹窗「周报」tab。
 * 数据源 /api/weekly-review（周五 18:00 cron 生成的快照，单一事实源）。
 * 结构：顶部「本周速览」KPI 网格（数据说话）→ 本周胜率（筛选 T+1 / 做T 次日）→ 各功能明细。
 * 设计为截图友好：白底宽版、大数字、色块徽章；底部"复制小结"一键复制纯文本版便于发群。
 * 原首页 WeeklyReviewModal 的 Modal 外壳已剥掉，改由 ReviewModal 统一承载。
 */

import { useEffect, useState, useCallback } from 'react';
import { Calendar, Copy, Check } from 'lucide-react';
import { cn } from '@/lib/utils';

interface WinRateStat {
  n: number;
  hit?: number; // tscore 用：命中数（买点次日涨/卖点次日跌）
  win?: number; // aiScreen 用：上涨数
  rate: number | null;
  avgReturn: number | null;
}

interface WeeklyReviewPayload {
  weekStart: string;
  weekLabel: string;
  generatedAt: string;
  summary: string;
  market: { upCount: number; downCount: number; avgChange: number | null; days: { date: string; up: number; down: number }[] };
  sentiment: {
    limitUpTotal: number;
    limitDownTotal: number;
    days: { date: string; up: number; down: number; newHigh: number | null }[];
    northTotalWan: number;
  };
  aiScreen: {
    runs: number;
    picks: number;
    evaluatedT1: number;
    best: { name: string; tsCode: string; t1: number | null }[];
    worst: { name: string; tsCode: string; t1: number | null }[];
    winRate: WinRateStat & { byStrategy: { name: string; n: number; win: number; rate: number | null; avgReturn: number | null }[] };
  };
  tscore: { buy: WinRateStat; sell: WinRateStat };
  deep: { count: number; byAction: Record<string, number>; topPicks: { name: string; confidence: number | null; target: number | null }[] };
  alerts: { total: number; topRules: { label: string; n: number }[]; topStocks: { name: string; n: number }[] };
}

const signed = (v: number | null | undefined) => (v == null ? '--' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);
const pct1 = (v: number | null | undefined) => (v == null ? '--' : `${v.toFixed(1)}%`);

/** 纯文本版小结（复制用） */
function toText(p: WeeklyReviewPayload): string {
  const tscoreTxt = (() => {
    const parts: string[] = [];
    if (p.tscore?.buy?.n) parts.push(`买点次日命中 ${p.tscore.buy.rate}%（${p.tscore.buy.hit}/${p.tscore.buy.n}）`);
    if (p.tscore?.sell?.n) parts.push(`卖点次日命中 ${p.tscore.sell.rate}%（${p.tscore.sell.hit}/${p.tscore.sell.n}）`);
    return parts.join('，');
  })();
  const lines = [
    `📊 本周回顾 ${p.weekLabel}`,
    '',
    p.summary,
    '',
    '【本周胜率】',
    p.aiScreen?.winRate?.n ? `筛选 T+1 胜率 ${p.aiScreen.winRate.rate}%（${p.aiScreen.winRate.win}/${p.aiScreen.winRate.n}，平均 ${signed(p.aiScreen.winRate.avgReturn)}）` : '筛选 T+1 暂无回填样本',
    tscoreTxt || '做T信号暂无回填样本',
    '',
    '【市场】',
    `涨 ${p.market.upCount} 家 / 跌 ${p.market.downCount} 家，周均涨跌 ${signed(p.market.avgChange)}`,
    ...p.market.days.map((d) => `  ${d.date}：涨 ${d.up} / 跌 ${d.down}`),
    `涨停 ${p.sentiment?.limitUpTotal ?? '--'} 家 / 跌停 ${p.sentiment?.limitDownTotal ?? '--'} 家${p.sentiment?.northTotalWan ? `，北向净流入 ${(p.sentiment.northTotalWan / 10000).toFixed(1)} 亿` : ''}`,
    '',
    '【AI 筛选】',
    `运行 ${p.aiScreen.runs} 次，入选 ${p.aiScreen.picks} 条`,
    ...(p.aiScreen.best.length ? [`本周 T+1 最佳：${p.aiScreen.best.map((b) => `${b.name} ${signed(b.t1)}`).join('、')}`] : []),
    ...(p.aiScreen.worst.length ? [`本周 T+1 最差：${p.aiScreen.worst.map((b) => `${b.name} ${signed(b.t1)}`).join('、')}`] : []),
    '',
    '【深度分析】',
    `共 ${p.deep.count} 次：${Object.entries(p.deep.byAction).map(([a, n]) => `${a} ${n}`).join(' / ') || '暂无'}`,
    ...(p.deep.topPicks.length ? [`高信心买入：${p.deep.topPicks.map((t) => t.name).join('、')}`] : []),
    '',
    '【预警】',
    `本周触发 ${p.alerts.total} 次`,
    ...(p.alerts.topRules.length ? [`最活跃：${p.alerts.topRules.slice(0, 5).map((r) => `${r.label}×${r.n}`).join('、')}`] : []),
  ];
  return lines.join('\n');
}

function StatCard({ label, main, sub, tone }: { label: string; main: string; sub?: string; tone?: 'up' | 'down' }) {
  return (
    <div className="text-center bg-white/60 dark:bg-gray-900/40 rounded-[var(--radius-md)] py-2 px-1">
      <div className="text-[10px] text-gray-400 truncate">{label}</div>
      <div className={cn(
        'text-lg font-bold leading-tight',
        tone === 'up' ? 'text-[var(--color-up)]' : tone === 'down' ? 'text-[var(--color-down)]' : 'text-gray-800 dark:text-gray-100'
      )}>{main}</div>
      {sub && <div className="text-[10px] text-gray-400 truncate">{sub}</div>}
    </div>
  );
}

export function WeeklyReview() {
  const [payload, setPayload] = useState<WeeklyReviewPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/weekly-review');
      const data = await res.json();
      setPayload(data?.review?.payload ?? null);
    } catch {
      setPayload(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const copy = async () => {
    if (!payload) return;
    try {
      await navigator.clipboard.writeText(toText(payload));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  };

  const p = payload;

  // 速览 KPI（旧快照无 tscore/winRate 字段时兜底）
  const winRate = p?.aiScreen?.winRate;
  const tscore = p?.tscore;
  const tscoreTotalN = (tscore?.buy?.n ?? 0) + (tscore?.sell?.n ?? 0);
  const tscoreTotalHit = (tscore?.buy?.hit ?? 0) + (tscore?.sell?.hit ?? 0);
  const tscoreCombinedRate = tscoreTotalN ? Math.round((tscoreTotalHit / tscoreTotalN) * 10) / 10 : null;

  return (
    <div className="p-5">
      {loading && <div className="text-center py-16 text-gray-400 text-sm">加载中...</div>}
      {!loading && !p && (
        <div className="text-center py-16">
          <Calendar className="w-12 h-12 mx-auto mb-3 opacity-20" />
          <p className="text-gray-500">本周回顾尚未生成</p>
          <p className="text-xs text-gray-400 mt-1">每周五晚自动生成，生成后在这里查看</p>
        </div>
      )}
      {!loading && p && (
        <div className="space-y-4">
          {/* 标题区（截图友好） */}
          <div className="text-center pb-3 border-b border-gray-100 dark:border-gray-800">
            <div className="text-[10px] text-gray-400 tracking-widest mb-1">WEEKLY REVIEW</div>
            <h2 className="text-xl font-bold text-gray-900 dark:text-white">本周回顾</h2>
            <p className="text-xs text-gray-400 mt-0.5">{p.weekLabel}</p>
          </div>

          {/* 本周速览：KPI 网格（数据说话，替代大段文字） */}
          <div className="bg-[var(--color-brand-soft)]/60 dark:bg-[var(--color-brand-soft)]/30 rounded-[var(--radius-lg)] px-4 py-3">
            <div className="grid grid-cols-3 gap-2">
              <StatCard
                label="涨跌家数"
                main={`${p.market.upCount}/${p.market.downCount}`}
                sub={`周均 ${signed(p.market.avgChange)}`}
                tone={(p.market.avgChange ?? 0) >= 0 ? 'up' : 'down'}
              />
              <StatCard
                label="筛选 T+1 胜率"
                main={winRate?.rate != null ? pct1(winRate.rate) : '--'}
                sub={winRate?.n ? `${winRate.win}/${winRate.n} 上涨` : '暂无样本'}
                tone={winRate?.rate != null ? (winRate.rate >= 50 ? 'up' : 'down') : undefined}
              />
              <StatCard
                label="做T次日命中"
                main={tscoreCombinedRate != null ? pct1(tscoreCombinedRate) : '--'}
                sub={tscoreTotalN ? `买 ${pct1(tscore?.buy?.rate)} · 卖 ${pct1(tscore?.sell?.rate)}` : '暂无样本'}
                tone={tscoreCombinedRate != null ? (tscoreCombinedRate >= 50 ? 'up' : 'down') : undefined}
              />
              <StatCard label="预警触发" main={String(p.alerts.total)} sub="本周" />
              <StatCard label="深度建议" main={String(p.deep.count)} sub="次分析" />
              <StatCard
                label="涨停家数"
                main={p.sentiment?.limitUpTotal != null ? String(p.sentiment.limitUpTotal) : '--'}
                sub={p.sentiment?.limitDownTotal != null ? `跌停 ${p.sentiment.limitDownTotal}` : undefined}
                tone={p.sentiment?.limitUpTotal ? 'up' : undefined}
              />
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-2.5 whitespace-pre-wrap leading-relaxed">{p.summary}</p>
          </div>

          {/* 本周胜率：筛选 T+1 + 做T 次日 */}
          {((winRate?.n ?? 0) > 0 || tscoreTotalN > 0) && (
            <div>
              <h3 className="text-xs font-semibold text-gray-500 mb-2">本周胜率</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {/* AI 筛选 T+1 */}
                <div className="rounded-[var(--radius-lg)] bg-gray-50 dark:bg-gray-800/50 p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-500">筛选 T+1 胜率</span>
                    {winRate?.rate != null && (
                      <span className={cn('text-xl font-bold', winRate.rate >= 50 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]')}>{pct1(winRate.rate)}</span>
                    )}
                  </div>
                  {winRate?.n ? (
                    <>
                      <div className="text-[10px] text-gray-400 mt-0.5">{winRate.win}/{winRate.n} 上涨 · 平均 {signed(winRate.avgReturn)}</div>
                      {winRate.byStrategy?.slice(0, 3).map((s) => (
                        <div key={s.name} className="flex items-center justify-between text-[11px] mt-1.5">
                          <span className="text-gray-600 dark:text-gray-300">{s.name}</span>
                          <span className="text-gray-400">{s.rate != null ? `${s.rate}%` : '--'} · {s.n}条</span>
                        </div>
                      ))}
                    </>
                  ) : (
                    <div className="text-[11px] text-gray-400 mt-1.5">本周暂无样本</div>
                  )}
                </div>
                {/* 做T 次日 */}
                <div className="rounded-[var(--radius-lg)] bg-gray-50 dark:bg-gray-800/50 p-3">
                  <div className="text-xs text-gray-500 mb-2">做T 信号次日命中</div>
                  {(tscore?.buy?.n || tscore?.sell?.n) ? (
                    <>
                      <div className="flex items-center gap-3">
                        <div className="flex-1 text-center">
                          <div className={cn('text-xl font-bold', tscore!.buy.rate != null && tscore!.buy.rate >= 50 ? 'text-[var(--color-up)]' : 'text-gray-700 dark:text-gray-200')}>
                            {tscore!.buy.rate != null ? pct1(tscore!.buy.rate) : '--'}
                          </div>
                          <div className="text-[10px] text-gray-400">买点（{tscore!.buy.n}）次日涨</div>
                        </div>
                        <div className="flex-1 text-center">
                          <div className={cn('text-xl font-bold', tscore!.sell.rate != null && tscore!.sell.rate >= 50 ? 'text-[var(--color-up)]' : 'text-gray-700 dark:text-gray-200')}>
                            {tscore!.sell.rate != null ? pct1(tscore!.sell.rate) : '--'}
                          </div>
                          <div className="text-[10px] text-gray-400">卖点（{tscore!.sell.n}）次日跌</div>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="text-[11px] text-gray-400">本周暂无样本</div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* 市场 */}
          <div>
            <h3 className="text-xs font-semibold text-gray-500 mb-2">市场</h3>
            <div className="flex items-center gap-3 mb-2">
              <div className="flex-1 text-center bg-[var(--color-up-soft)] rounded-[var(--radius-lg)] py-2">
                <div className="text-lg font-bold text-[var(--color-up)]">{p.market.upCount}</div>
                <div className="text-[10px] text-gray-400">上涨家数</div>
              </div>
              <div className="flex-1 text-center bg-[var(--color-down-soft)] rounded-[var(--radius-lg)] py-2">
                <div className="text-lg font-bold text-[var(--color-down)]">{p.market.downCount}</div>
                <div className="text-[10px] text-gray-400">下跌家数</div>
              </div>
              <div className="flex-1 text-center bg-gray-100 dark:bg-gray-800 rounded-[var(--radius-lg)] py-2">
                <div className={cn('text-lg font-bold', (p.market.avgChange ?? 0) >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]')}>{signed(p.market.avgChange)}</div>
                <div className="text-[10px] text-gray-400">周均涨跌</div>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {p.market.days.map((d) => (
                <span key={d.date} className="text-[11px] px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-500">
                  {d.date} <b className={d.up > d.down ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}>{d.up}</b>/{d.down}
                </span>
              ))}
            </div>

            {/* 市场情绪：涨停/跌停 + 20日新高 + 北向资金（旧快照无 sentiment 字段则跳过） */}
            {p.sentiment && (
              <div className="mt-2.5 space-y-2">
                <div className="flex items-center gap-3">
                  <div className="flex-1 text-center bg-[var(--color-up-soft)] rounded-[var(--radius-lg)] py-1.5">
                    <div className="text-base font-bold text-[var(--color-up)]">{p.sentiment.limitUpTotal}</div>
                    <div className="text-[10px] text-gray-400">涨停合计</div>
                  </div>
                  <div className="flex-1 text-center bg-[var(--color-down-soft)] rounded-[var(--radius-lg)] py-1.5">
                    <div className="text-base font-bold text-[var(--color-down)]">{p.sentiment.limitDownTotal}</div>
                    <div className="text-[10px] text-gray-400">跌停合计</div>
                  </div>
                  <div className="flex-1 text-center bg-gray-100 dark:bg-gray-800 rounded-[var(--radius-lg)] py-1.5">
                    <div className={cn('text-base font-bold', (p.sentiment.northTotalWan ?? 0) >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]')}>
                      {p.sentiment.northTotalWan != null ? `${(p.sentiment.northTotalWan / 10000).toFixed(1)}亿` : '--'}
                    </div>
                    <div className="text-[10px] text-gray-400">北向周净流入</div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {p.sentiment.days.map((d) => (
                    <span key={d.date} className="text-[11px] px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-500">
                      {d.date} <b className="text-[var(--color-up)]">{d.up}</b>/<b className="text-[var(--color-down)]">{d.down}</b>
                      {d.newHigh != null && <span className="text-gray-400"> 新高{d.newHigh}</span>}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* AI 筛选 明细 */}
          <div>
            <h3 className="text-xs font-semibold text-gray-500 mb-2">AI 筛选</h3>
            <div className="flex items-center gap-3 mb-2">
              <div className="flex-1 text-center bg-gray-100 dark:bg-gray-800 rounded-[var(--radius-lg)] py-2">
                <div className="text-lg font-bold text-gray-800 dark:text-gray-100">{p.aiScreen.runs}</div>
                <div className="text-[10px] text-gray-400">运行次数</div>
              </div>
              <div className="flex-1 text-center bg-gray-100 dark:bg-gray-800 rounded-[var(--radius-lg)] py-2">
                <div className="text-lg font-bold text-gray-800 dark:text-gray-100">{p.aiScreen.picks}</div>
                <div className="text-[10px] text-gray-400">入选建议</div>
              </div>
            </div>
            {p.aiScreen.best.length > 0 && (
              <div className="space-y-1 text-xs">
                {p.aiScreen.best.map((b) => (
                  <div key={b.tsCode} className="flex items-center justify-between px-2.5 py-1.5 rounded-[var(--radius-sm)] bg-[var(--color-up-soft)]">
                    <span className="text-gray-700 dark:text-gray-200 font-medium">🟢 {b.name} <span className="text-gray-400 text-[10px]">T+1 最佳</span></span>
                    <span className="font-mono font-semibold text-[var(--color-up)]">{signed(b.t1)}</span>
                  </div>
                ))}
                {p.aiScreen.worst.map((b) => (
                  <div key={b.tsCode} className="flex items-center justify-between px-2.5 py-1.5 rounded-[var(--radius-sm)] bg-[var(--color-down-soft)]">
                    <span className="text-gray-700 dark:text-gray-200 font-medium">🔻 {b.name} <span className="text-gray-400 text-[10px]">T+1 垫底</span></span>
                    <span className="font-mono font-semibold text-[var(--color-down)]">{signed(b.t1)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 深度分析 */}
          <div>
            <h3 className="text-xs font-semibold text-gray-500 mb-2">深度分析</h3>
            <div className="flex flex-wrap items-center gap-2 text-xs mb-2">
              <span className="px-2 py-1 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300">共 {p.deep.count} 次</span>
              {Object.entries(p.deep.byAction).map(([a, n]) => (
                <span key={a} className={cn('px-2 py-1 rounded-full', a === '买入' ? 'bg-[var(--color-up-soft)] text-[var(--color-up)]' : a === '卖出' ? 'bg-[var(--color-down-soft)] text-[var(--color-down)]' : 'bg-gray-100 dark:bg-gray-800 text-gray-500')}>
                  {a} {n}
                </span>
              ))}
            </div>
            {p.deep.topPicks.length > 0 && (
              <p className="text-xs text-gray-500">
                高信心买入：<b className="text-[var(--color-up)]">{p.deep.topPicks.map((t) => t.name).join('、')}</b>
              </p>
            )}
          </div>

          {/* 预警 */}
          <div>
            <h3 className="text-xs font-semibold text-gray-500 mb-2">预警</h3>
            <div className="flex items-center gap-3 mb-2">
              <div className="flex-1 text-center bg-gray-100 dark:bg-gray-800 rounded-[var(--radius-lg)] py-2">
                <div className="text-lg font-bold text-gray-800 dark:text-gray-100">{p.alerts.total}</div>
                <div className="text-[10px] text-gray-400">本周触发</div>
              </div>
              <div className="flex-[2] space-y-1">
                {p.alerts.topRules.slice(0, 3).map((r) => (
                  <div key={r.label} className="flex items-center justify-between text-xs px-2.5 py-1 rounded-[var(--radius-sm)] bg-gray-50 dark:bg-gray-800/50">
                    <span className="text-gray-600 dark:text-gray-300">{r.label}</span>
                    <span className="font-mono text-gray-500">×{r.n}</span>
                  </div>
                ))}
              </div>
            </div>
            {p.alerts.topStocks.length > 0 && (
              <p className="text-xs text-gray-500">
                最活跃标的：<b className="text-gray-700 dark:text-gray-200">{p.alerts.topStocks.map((s) => `${s.name}×${s.n}`).join('、')}</b>
              </p>
            )}
          </div>

          {/* 复制 */}
          <div className="flex justify-center pt-2 border-t border-gray-100 dark:border-gray-800">
            <button
              onClick={copy}
              className={cn(
                'flex items-center gap-1.5 px-4 py-2 rounded-[var(--radius-md)] text-sm font-medium transition',
                copied ? 'bg-[var(--color-down-soft)] text-[var(--color-down)]' : 'bg-[var(--color-accent)] text-white hover:opacity-90'
              )}
            >
              {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              {copied ? '已复制，去群里分享吧' : '复制小结'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
