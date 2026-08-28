'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useUiStore } from '@/store/ui-store';
import { useStockStore } from '@/store';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import { ChevronDown, ChevronUp, Info, AlertTriangle, Loader2, Plus, Minus, Copy } from 'lucide-react';
import { toast } from 'sonner';

/**
 * 超短线主 tab — 三套短线形态策略（涨停+三连阴 / 龙首阴 / 双龙战法）的候选列表。
 * 数据来自 GET /api/short-term-strategies（后端两阶段扫描落库快照）。
 * 只读展示：形态符合 + 强度分级，不输出操作指引。
 */

export type ShortTermStrategyId = 'limit-up-three-yin' | 'dragon-first-yin' | 'double-dragon';

interface ShortTermStrategyMeta {
  id: ShortTermStrategyId;
  name: string;
  description: string;
  rulesText: string;
}

const STRATEGIES: ShortTermStrategyMeta[] = [
  {
    id: 'limit-up-three-yin',
    name: '涨停+三连阴',
    description: '涨停后连续三根缩量小阴线',
    rulesText: '涨停日非一字板；随后三日小阴线、收盘逐日走低、量能递减，尾盘不急速拉升时形态符合。',
  },
  {
    id: 'dragon-first-yin',
    name: '龙首阴',
    description: '连板后首根阴线，换手充分',
    rulesText: '连续涨停后首根阴线；换手充分、量能承接、实体不超 7%；高位板需假阴真阳。',
  },
  {
    id: 'double-dragon',
    name: '双龙战法',
    description: '首板非一字实体板，二板连续涨停',
    rulesText: '首板为非一字实体板；二板连续涨停且只认恰好二板；封板早于首板更稳，二板一字板不作为硬性剔除。',
  },
];

interface MarketContext {
  mode: 'attack' | 'neutral' | 'defense';
  tradable: boolean;
  limitUpCount: number;
  limitDownCount: number;
  brokenCount: number | null;
  highestBoard: number | null;
  warnings: string[];
}

interface ShortTermCandidate {
  strategy: ShortTermStrategyId;
  tsCode: string;
  name: string;
  signalType: string;
  matchedDate: string;
  priority: 'high' | 'medium' | 'low';
  reason: string;
  summary: string | null;
  metrics: Record<string, unknown>;
}

interface ShortTermResponse {
  strategies: { id: string; name: string; description: string }[];
  phase: 'closing' | 'morning';
  tradeDate: string; // YYYYMMDD
  generated: boolean;
  generatedAt: string | null;
  market: MarketContext | null;
  candidates: Record<string, ShortTermCandidate[]>;
}

const REGIME_LABEL: Record<'attack' | 'neutral' | 'defense', string> = {
  attack: '活跃',
  neutral: '震荡',
  defense: '收缩',
};

const PRIORITY_LABEL: Record<'high' | 'medium' | 'low', string> = {
  high: '强',
  medium: '中',
  low: '弱',
};

const QUALITY_LABEL: Record<string, string> = {
  turnover: '换手板',
  mixed: '混合板',
  oneWord: '一字板',
};

function numMetric(m: Record<string, unknown>, k: string): number | null {
  const v = m[k];
  return typeof v === 'number' ? v : null;
}

function strMetric(m: Record<string, unknown>, k: string): string | null {
  const v = m[k];
  return typeof v === 'string' ? v : null;
}

function arrMetric(m: Record<string, unknown>, k: string): number[] | null {
  const v = m[k];
  return Array.isArray(v) ? (v as number[]) : null;
}

function signalLabel(signalType: string): string | null {
  if (signalType === 'firstYinToday') return '首阴当日';
  if (signalType === 'firstYinYesterday') return '首阴次日';
  if (signalType === 'double_dragon_board') return '二板封板';
  if (signalType === 'double_dragon_pullback') return '回踩';
  return null;
}

function hitLine(strategy: ShortTermStrategyId, signalType: string): string {
  if (strategy === 'limit-up-three-yin') return '涨停+三连阴形态符合';
  if (strategy === 'dragon-first-yin') return '龙首阴形态符合';
  if (strategy === 'double-dragon') {
    return signalType === 'double_dragon_pullback' ? '回踩形态符合' : '二板封板形态符合';
  }
  return '形态符合';
}

function formatDate(ymd: string): string {
  if (/^\d{8}$/.test(ymd)) return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
  return ymd;
}

function toStock(tsCodeFull: string, name: string) {
  const tsCode = tsCodeFull.replace(/\.(SH|SZ|BJ)$/, '');
  const isSH = tsCode.startsWith('6') || tsCode.startsWith('68');
  const isBJ = tsCode.startsWith('4') || tsCode.startsWith('8') || tsCode.startsWith('9');
  const market = isSH ? 'sh' : isBJ ? 'bj' : 'sz';
  const pureCode = tsCode.replace(/^(sh|sz|bj)/i, '');
  return { code: `${market}${pureCode}`, name, market, pureCode };
}

function toAppCode(tsCode: string) {
  const m = tsCode.match(/^(\d+)\.(SH|SZ|BJ)$/);
  return m ? m[2].toLowerCase() + m[1] : tsCode;
}

export function ShortTermTab() {
  const router = useRouter();
  const selected = useUiStore((s) => s.shortTermStrategy);
  const setSelected = useUiStore((s) => s.setShortTermStrategy);
  const addToWatchlist = useStockStore((s) => s.addToWatchlist);
  const removeFromWatchlist = useStockStore((s) => s.removeFromWatchlist);
  const isInWatchlist = useStockStore((s) => s.isInWatchlist);

  const [resp, setResp] = useState<ShortTermResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [showRules, setShowRules] = useState(false);

  const meta = STRATEGIES.find((s) => s.id === selected) ?? STRATEGIES[0];

  // 一次拉取三套策略的快照结果，子 tab 切换只做本地过滤（无需重复请求）
  useEffect(() => {
    let cancelled = false;
    fetch('/api/short-term-strategies')
      .then((r) => r.json())
      .then((d: ShortTermResponse) => {
        if (cancelled) return;
        if (d && d.candidates) setResp(d);
        else setResp(null);
      })
      .catch(() => {
        if (!cancelled) setResp(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const addWatch = (tsCode: string, name: string) => {
    addToWatchlist(toStock(tsCode, name));
    toast.success(`已添加 ${name}`);
  };
  const removeWatch = (tsCode: string, name: string) => {
    removeFromWatchlist(toAppCode(tsCode));
    toast.success(`已移除 ${name}`);
  };

  const market = resp?.market ?? null;
  const candidates = resp?.candidates?.[selected] ?? [];

  const copyCurrentCandidates = async () => {
    if (!candidates.length) return;
    const lines = candidates.map((c) => `${c.name} ${c.tsCode.replace(/\.(SH|SZ|BJ)$/, '')}`);
    const text = lines.join('\n');
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch {
        ok = false;
      }
    }
    if (ok) toast.success(`已复制 ${candidates.length} 只候选到剪贴板`);
    else toast.error('复制失败，请手动复制');
  };

  // 双龙打板口径局限：优先用后端 metrics.caveat（仅 double_dragon_board 有），缺省回退前端合规文案
  const boardCaveat = (() => {
    const dd = resp?.candidates?.['double-dragon'] ?? [];
    const board = dd.find((c) => c.signalType === 'double_dragon_board');
    const caveat = board ? strMetric(board.metrics, 'caveat') : null;
    return caveat ?? '打板口径按历史基线，未计入一字板成交受限与封板先后等盘口条件，结果偏乐观，仅供参考';
  })();

  const coreChips = (c: ShortTermCandidate): { label: string; tone?: 'red' | 'green' | 'gray' }[] => {
    const m = c.metrics;
    switch (c.strategy) {
      case 'limit-up-three-yin': {
        const yinBodies = arrMetric(m, 'yinBodies');
        const entryClose = numMetric(m, 'entryClose');
        return [
          yinBodies && yinBodies.length === 3
            ? { label: `三阴实体 ${yinBodies.map((b) => b.toFixed(1)).join(' / ')}%` }
            : { label: '三阴缩量' },
          { label: '量能递减' },
          entryClose != null ? { label: `尾盘价 ${entryClose.toFixed(2)}` } : { label: '尾盘观察' },
        ];
      }
      case 'dragon-first-yin': {
        const chips: { label: string; tone?: 'red' | 'green' | 'gray' }[] = [];
        const boardCount = numMetric(m, 'boardCount');
        const yinType = strMetric(m, 'yinType');
        const quality = strMetric(m, 'quality');
        const volumeRatio = numMetric(m, 'volumeRatio');
        const turnoverRate = numMetric(m, 'turnoverRate');
        const bodyPct = numMetric(m, 'bodyPct');
        if (boardCount != null) chips.push({ label: `${boardCount}板` });
        if (yinType) chips.push({ label: yinType });
        if (quality && QUALITY_LABEL[quality]) chips.push({ label: QUALITY_LABEL[quality] });
        if (volumeRatio != null) chips.push({ label: `量比 ${volumeRatio.toFixed(1)}` });
        if (turnoverRate != null) chips.push({ label: `换手 ${turnoverRate.toFixed(1)}%` });
        if (bodyPct != null) chips.push({ label: `实体 ${bodyPct.toFixed(1)}%` });
        return chips;
      }
      case 'double-dragon': {
        const chips: { label: string; tone?: 'red' | 'green' | 'gray' }[] = [];
        const realtime = strMetric(m, 'realtime');
        const entryPrice = numMetric(m, 'entryPrice');
        if (realtime === 'passed') chips.push({ label: '封板早于一板', tone: 'green' });
        else if (realtime === 'unavailable') chips.push({ label: '封板待确认', tone: 'gray' });
        if (entryPrice != null) chips.push({ label: `参考价 ${entryPrice.toFixed(2)}` });
        return chips;
      }
    }
    return [];
  };

  return (
    <div>
      {/* 三个子 tab */}
      <div className="flex gap-1 mb-4 p-1 bg-gray-100 dark:bg-gray-800 rounded-lg w-fit flex-wrap">
        {STRATEGIES.map((s) => (
          <button
            key={s.id}
            onClick={() => setSelected(s.id)}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm transition',
              selected === s.id
                ? 'bg-white dark:bg-gray-900 shadow-sm font-medium text-gray-900 dark:text-white'
                : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-200',
            )}
          >
            {s.name}
          </button>
        ))}
      </div>

      {/* 策略说明（默认折叠） */}
      <div className="mb-4">
        <button onClick={() => setShowRules(!showRules)} className="flex items-center gap-1 text-xs text-purple-600">
          <Info className="w-3.5 h-3.5" /> 策略说明
          {showRules ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </button>
        {showRules && (
          <div className="mt-2 rounded-xl bg-purple-50/60 dark:bg-purple-950/20 border border-purple-100 dark:border-purple-900 p-3 text-xs text-gray-600 dark:text-gray-400 space-y-2">
            <p className="whitespace-pre-line leading-relaxed">{meta.description}</p>
            <p className="whitespace-pre-line leading-relaxed opacity-90">{meta.rulesText}</p>
          </div>
        )}
      </div>

      {/* 双龙打板口径局限提示 */}
      {selected === 'double-dragon' && (
        <div className="mb-4 text-xs text-amber-600 flex items-start gap-1">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>{boardCaveat}</span>
        </div>
      )}

      {/* 运行概况 */}
      {resp && (
        <Card className="p-3 mb-4">
          <div className="flex flex-wrap items-center gap-3 text-xs text-gray-500">
            <span>数据日 {formatDate(resp.tradeDate)}</span>
            <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">{resp.phase === 'closing' ? '尾盘' : '早盘'}</span>
            {market && (
              <span
                className={cn(
                  'px-1.5 py-0.5 rounded',
                  market.mode === 'attack'
                    ? 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400'
                    : market.mode === 'defense'
                      ? 'bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-400'
                      : 'bg-gray-100 text-gray-600',
                )}
              >
                {REGIME_LABEL[market.mode]}
              </span>
            )}
          </div>
          {(market?.tradable === false || market?.mode === 'defense' || (market?.warnings?.length ?? 0) > 0) && (
            <div className="text-xs text-amber-600 flex items-start gap-1 mt-2">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>
                {market?.tradable === false || market?.mode === 'defense'
                  ? '退潮期，形态参考即可'
                  : (market?.warnings ?? []).slice(0, 2).join('；')}
              </span>
            </div>
          )}
        </Card>
      )}

      {/* 候选列表 */}
      {loading ? (
        <div className="text-center py-16 text-gray-400">
          <Loader2 className="w-8 h-8 mx-auto mb-3 animate-spin" />
          <p className="text-sm">读取中…</p>
        </div>
      ) : candidates.length > 0 ? (
        <div>
          {candidates.map((c) => {
            const sig = signalLabel(c.signalType);
            const chips = coreChips(c);
            const appCode = toAppCode(c.tsCode);
            return (
              <Card key={c.tsCode} className="p-3 mb-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <button
                      onClick={() => router.push(`/stock/${appCode}`)}
                      className="font-medium text-blue-600 hover:underline text-left"
                    >
                      {c.name}
                    </button>
                    <div className="text-gray-400 text-xs mt-0.5">
                      {c.tsCode.replace(/\.(SH|SZ|BJ)$/, '')} · 形态触发 {c.matchedDate}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span
                      className={cn(
                        'px-1.5 py-0.5 rounded text-xs',
                        c.priority === 'high'
                          ? 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400'
                          : c.priority === 'medium'
                            ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400'
                            : 'bg-gray-100 text-gray-600',
                      )}
                    >
                      {PRIORITY_LABEL[c.priority]}
                    </span>
                    {isInWatchlist(appCode) ? (
                      <button
                        onClick={() => removeWatch(c.tsCode, c.name)}
                        className="inline-flex p-1.5 text-gray-400 hover:text-red-500 rounded-[var(--radius-md)] transition"
                        title="移除自选"
                      >
                        <Minus className="w-4 h-4" />
                      </button>
                    ) : (
                      <button
                        onClick={() => addWatch(c.tsCode, c.name)}
                        className="inline-flex p-1.5 bg-purple-100 text-purple-700 dark:bg-purple-950/40 dark:text-purple-300 rounded-[var(--radius-md)] hover:opacity-80 transition"
                        title="加自选"
                      >
                        <Plus className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
                <div className="mt-1.5 text-sm text-gray-700 dark:text-gray-300">{hitLine(c.strategy, c.signalType)}</div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {sig && (
                    <span className="px-1.5 py-0.5 rounded text-xs bg-purple-50 text-purple-600 dark:bg-purple-950/40 dark:text-purple-300">
                      {sig}
                    </span>
                  )}
                  {chips.map((ch) => (
                    <span
                      key={ch.label}
                      className={cn(
                        'px-1.5 py-0.5 rounded text-xs',
                        ch.tone === 'green'
                          ? 'bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-400'
                          : ch.tone === 'red'
                            ? 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400'
                            : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300',
                      )}
                    >
                      {ch.label}
                    </span>
                  ))}
                </div>
              </Card>
            );
          })}
        </div>
      ) : resp && resp.generated ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-lg">今日无标的命中</p>
          <p className="text-sm mt-2">形态未触发</p>
        </div>
      ) : (
        <div className="text-center py-16 text-gray-400">
          <p className="text-lg">筛选尚未生成</p>
          <p className="text-sm mt-2">尾盘后自动生成，稍后查看</p>
        </div>
      )}

      {candidates.length > 0 && (
        <div className="mt-4 flex flex-col items-end gap-1">
          <button
            onClick={copyCurrentCandidates}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-purple-600 text-white text-sm font-medium hover:bg-purple-700 transition"
          >
            <Copy className="w-4 h-4" />
            一键复制本组候选 ({candidates.length})
          </button>
          <span className="text-xs text-gray-400">复制内容为「名称 代码」，可粘贴到同花顺自选文本识别</span>
        </div>
      )}
    </div>
  );
}
