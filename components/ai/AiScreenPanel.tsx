'use client';

/**
 * AI 筛选面板 — 嵌入 AI 分析页的筛选模式。
 * 复用父级 AI 页的 LLM 配置档（currentProfile），不再单独配置。
 * 后端按「策略+数据日」去重，首跑者花 token，后续秒取缓存；降级时后续 token 自动补救。
 */

import { useState, useEffect, useCallback, useMemo, Fragment } from 'react';
import { useRouter } from 'next/navigation';
import { useAiScreenStore } from '@/store/ai-screen-store';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import { Loader2, ChevronDown, ChevronUp, AlertTriangle, History, Info, Sparkles, BarChart3, Filter } from 'lucide-react';
import { toast } from 'sonner';
import type { AiProfile } from '@/store/ai-store';
import type { AiPick, AiScreenRun } from '@/services/ai-screen/types';
import { AiScreenStats } from './AiScreenStats';

interface StrategyInfo {
  id: string;
  name: string;
  description: string;
  category: string;
  rulesText: string;
}

interface IndustryInfo {
  name: string;
  count: number;
  l2: string[];
}

interface RunListItem {
  id: string;
  strategyId: string;
  strategyName: string;
  createdAt: string;
  barDate: string;
  rpsPeriod: number;
  candidateCount: number;
  pickCount: number;
  llmReranked: boolean;
  llmModel: string | null;
  llmCoverage: number | null;
  degradation: string[];
}

export function AiScreenPanel({ currentProfile }: { currentProfile: AiProfile }) {
  const router = useRouter();
  const { selectedStrategyId, setSelectedStrategy, lastRun, lastPicks, setLastRun } = useAiScreenStore();

  const [strategies, setStrategies] = useState<StrategyInfo[]>([]);
  const [industries, setIndustries] = useState<IndustryInfo[]>([]);
  const [history, setHistory] = useState<RunListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [showLlmDetail, setShowLlmDetail] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [view, setView] = useState<'screen' | 'stats'>('screen');
  const [sector, setSector] = useState('');
  const [level, setLevel] = useState<'L1' | 'L2'>('L1');
  const [board, setBoard] = useState('all');

  const refresh = useCallback(async () => {
    try {
      const [res, indRes] = await Promise.all([fetch('/api/ai-screen'), fetch('/api/industries')]);
      const data = await res.json();
      if (data.strategies) setStrategies(data.strategies);
      if (data.runs) setHistory(data.runs);
      const ind = await indRes.json();
      if (ind.industries) setIndustries(ind.industries);
    } catch {
      /* 静默 */
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const run = async () => {
    if (!currentProfile?.baseUrl || !currentProfile?.model) {
      toast.error('LLM 配置不完整');
      return;
    }
    setSector('');
    setBoard('all');
    setLoading(true);
    try {
      const res = await fetch('/api/ai-screen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          strategyId: selectedStrategyId,
          baseUrl: currentProfile.baseUrl,
          apiKey: currentProfile.apiKey,
          model: currentProfile.model,
        }),
      });
      const data = await res.json();
      if (data.error) {
        toast.error(data.error);
      } else {
        setLastRun(data.run, data.picks);
        toast.success(`筛选完成：${data.picks.length} 只入选`);
        refresh();
      }
    } catch {
      toast.error('请求失败');
    } finally {
      setLoading(false);
    }
  };

  const loadRun = async (runId: string, s = sector, l = level, b = board) => {
    try {
      const qs = new URLSearchParams();
      if (s) { qs.set('sector', s); qs.set('level', l); }
      if (b && b !== 'all') qs.set('board', b);
      const res = await fetch(`/api/ai-screen/${runId}?${qs}`);
      const data = await res.json();
      if (data.error) toast.error(data.error);
      else if (data.run) {
        setLastRun(data.run, data.run.picks || []);
        setShowHistory(false);
      }
    } catch {
      toast.error('加载失败');
    }
  };

  const applyFilter = () => {
    if (lastRun) loadRun(lastRun.id);
  };

  const toAppCode = (tsCode: string) => {
    const m = tsCode.match(/^(\d+)\.(SH|SZ|BJ)$/);
    return m ? m[2].toLowerCase() + m[1] : tsCode;
  };

  return (
    <div>
      {/* 视图切换 */}
      <div className="flex gap-1 mb-3 p-1 bg-gray-100 dark:bg-gray-800/50 rounded-lg w-fit">
        <button onClick={() => setView('screen')} className={cn('px-3 py-1 rounded-md text-xs font-medium', view === 'screen' ? 'bg-white dark:bg-gray-900 text-purple-600 shadow-sm' : 'text-gray-500')}>筛选</button>
        <button onClick={() => setView('stats')} className={cn('px-3 py-1 rounded-md text-xs font-medium flex items-center gap-1', view === 'stats' ? 'bg-white dark:bg-gray-900 text-purple-600 shadow-sm' : 'text-gray-500')}><BarChart3 className="w-3.5 h-3.5" /> 胜率复盘</button>
      </div>

      {view === 'stats' ? (
        <AiScreenStats />
      ) : (
        <>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
            规则硬筛 → 多因子打分 → AI 横向重排 → 风险/组合约束。AI 只在候选池内排序,不给目标价。
          </p>

      {/* 策略选择 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
        {(strategies.length ? strategies : []).map((s) => (
          <button
            key={s.id}
            onClick={() => setSelectedStrategy(s.id)}
            className={cn(
              'p-3 rounded-xl text-left border-2 transition',
              selectedStrategyId === s.id
                ? 'border-purple-500 bg-purple-50 dark:bg-purple-950/40'
                : 'border-gray-200 dark:border-gray-700 hover:border-gray-300',
            )}
          >
            <div className="font-medium text-sm text-gray-900 dark:text-white">{s.name}</div>
            <div className="text-xs text-gray-500 dark:text-gray-400 mt-1 line-clamp-2">{s.description}</div>
          </button>
        ))}
      </div>

      {/* 策略规则说明 */}
      {strategies.find((s) => s.id === selectedStrategyId)?.rulesText && (
        <div className="bg-gray-50 dark:bg-gray-800/40 rounded-xl p-3 mb-4 text-xs text-gray-600 dark:text-gray-400 whitespace-pre-line leading-relaxed">
          {strategies.find((s) => s.id === selectedStrategyId)!.rulesText}
        </div>
      )}

      {/* 运行 */}
      <Card className="p-4 mb-4">
        <button
          onClick={run}
          disabled={loading}
          className="w-full py-2.5 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-700 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
          {loading ? '筛选中…' : '运行筛选'}
        </button>
      </Card>

      {/* 历史运行 */}
      {history.length > 0 && (
        <div className="mb-4">
          <button onClick={() => setShowHistory(!showHistory)} className="flex items-center gap-1 text-sm text-gray-600 dark:text-gray-400 mb-2">
            <History className="w-4 h-4" /> 历史运行（{history.length}）
            {showHistory ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
          {showHistory && (
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {history.map((r) => (
                <button key={r.id} onClick={() => loadRun(r.id)} className="w-full text-left px-3 py-2 rounded-lg bg-gray-50 dark:bg-gray-800/50 hover:bg-gray-100 dark:hover:bg-gray-800 text-xs">
                  <span className="font-medium">{r.strategyName}</span>
                  <span className="text-gray-400 ml-2">{r.barDate} · {r.pickCount} 只 · {r.llmReranked ? 'AI重排' : '纯规则'}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 板块 + 主板过滤(展示层,不打分) */}
      {lastRun && (
        <Card className="p-3 mb-4">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Filter className="w-3.5 h-3.5 text-gray-400" />
            <span className="text-gray-500">板块</span>
            <select value={sector} onChange={(e) => setSector(e.target.value)} className="px-2 py-1 rounded border border-gray-200 dark:border-gray-700 bg-transparent text-gray-700 dark:text-gray-300 max-w-[160px]">
              <option value="">全市场</option>
              {industries.map((ind) => (
                <option key={ind.name} value={ind.name}>{ind.name}({ind.count})</option>
              ))}
            </select>
            <select value={level} onChange={(e) => setLevel(e.target.value as 'L1' | 'L2')} className="px-2 py-1 rounded border border-gray-200 dark:border-gray-700 bg-transparent text-gray-700 dark:text-gray-300">
              <option value="L1">一级行业</option>
              <option value="L2">二级行业</option>
            </select>
            <span className="text-gray-500 ml-1">市场</span>
            <select value={board} onChange={(e) => setBoard(e.target.value)} className="px-2 py-1 rounded border border-gray-200 dark:border-gray-700 bg-transparent text-gray-700 dark:text-gray-300">
              <option value="all">全部</option>
              <option value="main">主板</option>
              <option value="gem">创业板</option>
              <option value="star">科创板</option>
              <option value="bjse">北交所</option>
            </select>
            <button onClick={applyFilter} className="px-2 py-1 rounded bg-purple-600 text-white hover:bg-purple-700">应用</button>
            {(sector || board !== 'all') && (
              <button onClick={() => { setSector(''); setBoard('all'); if (lastRun) loadRun(lastRun.id, '', 'L1', 'all'); }} className="text-gray-400 hover:text-gray-600">清除</button>
            )}
          </div>
        </Card>
      )}

      {/* 结果 */}
      {lastRun && lastPicks.length > 0 ? (
        <RunResult
          run={lastRun}
          picks={lastPicks}
          expanded={expanded}
          setExpanded={setExpanded}
          showLlmDetail={showLlmDetail}
          setShowLlmDetail={setShowLlmDetail}
          onNav={(code) => router.push(`/stock/${toAppCode(code)}`)}
        />
      ) : (
        !loading && (
          <div className="text-center py-16 text-gray-400">
            <Sparkles className="w-16 h-16 mx-auto mb-4 opacity-20" />
            <p className="text-lg">选择策略，点击运行筛选</p>
            <p className="text-sm mt-2">AI 在规则筛出的候选池内做横向排序与风险标注</p>
          </div>
        )
      )}
        </>
      )}
    </div>
  );
}

function RunResult({
  run,
  picks,
  expanded,
  setExpanded,
  showLlmDetail,
  setShowLlmDetail,
  onNav,
}: {
  run: AiScreenRun;
  picks: AiPick[];
  expanded: number | null;
  setExpanded: (n: number | null) => void;
  showLlmDetail: boolean;
  setShowLlmDetail: (b: boolean) => void;
  onNav: (code: string) => void;
}) {
  // 结果排序：默认按 rank（后端综合序），可点表头切综合分/涨跌幅，再点切换升降序，三次点击回默认
  const [sortKey, setSortKey] = useState<'rank' | 'score' | 'change'>('rank');
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc');

  const toggleSort = (key: 'score' | 'change') => {
    setExpanded(null); // 排序变化后展开行会错位，先收起
    if (sortKey === key) {
      if (sortDir === 'desc') setSortDir('asc');
      else { setSortKey('rank'); setSortDir('desc'); }
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const sortedPicks = useMemo(() => {
    if (sortKey === 'rank') return picks;
    const val = (k: AiPick) => (sortKey === 'score' ? k.finalScore : k.latestChange);
    return [...picks].sort((a, b) => {
      const av = val(a), bv = val(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1; // 缺数据恒排最后
      if (bv == null) return -1;
      return sortDir === 'desc' ? bv - av : av - bv;
    });
  }, [picks, sortKey, sortDir]);

  const sortMark = (key: 'score' | 'change') =>
    sortKey === key ? (sortDir === 'desc' ? ' ↓' : ' ↑') : '';

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-3 text-sm mb-2">
          <span className="font-medium">{run.strategyName}</span>
          <span className="text-gray-400">数据日 {run.barDate}</span>
          <span className="text-gray-400">候选 {run.candidateCount}</span>
          <span className="text-gray-400">入选 {run.pickCount}</span>
          {run.llmReranked ? (
            <span className="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">AI 重排 {run.llmCoverage != null ? `${(run.llmCoverage * 100).toFixed(0)}%` : ''}</span>
          ) : (
            <span className="text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">纯规则</span>
          )}
          <span className="text-xs text-gray-400">RPS{run.rpsPeriod}</span>
        </div>
        {/* 降级警告只在结果未走成 AI 重排(纯规则兜底)时显示；
            补救/重排成功后 degradation 是历史留痕(rescued_by_later_token 等)，不再提示 */}
        {!run.llmReranked && run.degradation.length > 0 && (
          <div className="text-xs text-amber-600 flex items-start gap-1 mb-2">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>降级：{run.degradation.slice(0, 3).join('；')}{run.degradation.length > 3 ? '…' : ''}</span>
          </div>
        )}
        {run.llmReranked && (run.llmMarketView || run.llmSelectionLogic) && (
          <button onClick={() => setShowLlmDetail(!showLlmDetail)} className="flex items-center gap-1 text-xs text-purple-600">
            <Info className="w-3.5 h-3.5" /> AI 视角
            {showLlmDetail ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
        )}
        {showLlmDetail && (
          <div className="mt-2 text-xs text-gray-600 dark:text-gray-400 space-y-2">
            {run.llmMarketView && <p><strong>市场视角：</strong>{run.llmMarketView}</p>}
            {run.llmSelectionLogic && <p><strong>排序逻辑：</strong>{run.llmSelectionLogic}</p>}
            {run.llmPortfolioRisk && <p><strong>组合风险：</strong>{run.llmPortfolioRisk}</p>}
          </div>
        )}
      </Card>

      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 dark:border-gray-800 text-left text-xs text-gray-400 uppercase">
                <th className="px-3 py-2 w-10 whitespace-nowrap">#</th>
                <th className="px-3 py-2 whitespace-nowrap">标的</th>
                <th
                  className="px-3 py-2 text-right whitespace-nowrap cursor-pointer select-none hover:text-gray-600 dark:hover:text-gray-300"
                  title="点击按综合分排序"
                  onClick={() => toggleSort('score')}
                >综合分{sortMark('score')}</th>
                <th className="px-3 py-2 text-right whitespace-nowrap">规则/LLM</th>
                <th
                  className="px-3 py-2 text-right whitespace-nowrap cursor-pointer select-none hover:text-gray-600 dark:hover:text-gray-300"
                  title="点击按涨跌幅排序"
                  onClick={() => toggleSort('change')}
                >涨跌{sortMark('change')}</th>
                <th className="px-3 py-2 min-w-[220px]">理由 / 风险</th>
              </tr>
            </thead>
            <tbody>
              {sortedPicks.map((k, i) => (
                <Fragment key={k.tsCode}>
                  <tr
                    onClick={() => setExpanded(expanded === i ? null : i)}
                    className={cn(
                      'border-b border-gray-50 dark:border-gray-800/50 hover:bg-gray-50 dark:hover:bg-gray-800/30 transition cursor-pointer',
                      k.riskLevel === 'high' ? 'bg-red-50/30 dark:bg-red-950/10' : '',
                    )}
                  >
                    <td className="px-3 py-2.5 text-gray-400">{k.rank}</td>
                    <td className="px-3 py-2.5" onClick={(e) => { e.stopPropagation(); onNav(k.tsCode); }}>
                      <div className="font-medium text-blue-600 hover:underline">{k.name}</div>
                      <div className="text-gray-400 text-xs">{k.tsCode.replace(/\.(SH|SZ|BJ)$/, '')} · {k.industry || '--'}</div>
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono font-semibold">{k.finalScore.toFixed(1)}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-xs text-gray-500">
                      {k.screenScore.toFixed(0)}{k.llmScore != null ? `/${k.llmScore.toFixed(0)}` : ''}
                    </td>
                    <td className={cn('px-3 py-2.5 text-right font-mono', (k.latestChange ?? 0) >= 0 ? 'text-red-600' : 'text-green-600')}>
                      {k.latestChange != null ? `${k.latestChange >= 0 ? '+' : ''}${k.latestChange.toFixed(2)}%` : '--'}
                    </td>
                    <td className="px-3 py-2.5 text-xs">
                      <div className="text-gray-700 dark:text-gray-300 break-words">{k.rankingReason || k.llmThesis || '--'}</div>
                      <div className="flex gap-1 mt-1 flex-wrap">
                        {k.riskLevel !== 'low' && <span className={cn('px-1 py-0.5 rounded', k.riskLevel === 'high' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700')}>风险{k.riskLevel === 'high' ? '高' : '中'}</span>}
                        {k.llmTags.slice(0, 2).map((t) => (
                          <span key={t} className="px-1 py-0.5 rounded bg-gray-100 text-gray-600">{t}</span>
                        ))}
                      </div>
                    </td>
                  </tr>
                  {expanded === i && (
                    <tr className="bg-gray-50/50 dark:bg-gray-800/20">
                      <td colSpan={6} className="px-4 py-3 text-xs space-y-2">
                        {k.llmThesis && <p><strong>核心假设：</strong>{k.llmThesis}</p>}
                        {k.riskSummary && <p><strong>主要风险：</strong>{k.riskSummary}</p>}
                        {k.llmCatalysts.length > 0 && <p className="text-green-600">催化：{k.llmCatalysts.join('、')}</p>}
                        {k.llmWatchItems.length > 0 && <p className="text-gray-500">跟踪：{k.llmWatchItems.join('；')}</p>}
                        {k.llmInvalidators.length > 0 && <p className="text-red-500">证伪点：{k.llmInvalidators.join('；')}</p>}
                        <div className="flex flex-wrap gap-2 pt-1">
                          {Object.entries(k.factorScores).map(([fk, fv]) => (
                            <span key={fk} className="text-gray-500">{fk}:{fv.toFixed(0)}</span>
                          ))}
                        </div>
                        <div className="flex flex-wrap gap-3 text-gray-500 pt-1">
                          <span>RPS {k.rps?.toFixed(1) ?? '--'}</span>
                          <span>60日 {k.ret60d?.toFixed(1) ?? '--'}%</span>
                          <span>波动 {k.volatility20d?.toFixed(1) ?? '--'}%</span>
                          <span>回撤 {k.maxDrawdown20d?.toFixed(1) ?? '--'}%</span>
                          <span>量比 {k.volumeRatio?.toFixed(1) ?? '--'}</span>
                          <span>ROE {k.roe?.toFixed(1) ?? '--'}%</span>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
