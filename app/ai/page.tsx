'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import { useStockStore } from '@/store';
import { useAiStore, AiProfile } from '@/store/ai-store';
import { useUiStore } from '@/store/ui-store';
import type { Stock } from '@/types';
import { getRealtimeQuote, getKLineSina, getMinuteDataCached, getChipData, fetchMarketStatusNote, searchStocks, parseStockCode } from '@/services/stockApi';
import { ALERT_RULES, checkAllRules } from '@/services/alertRules';
import { buildTscoreSystemPrompt, buildTscoreUserPrompt } from '@/services/t-score/prompt';
import { buildIntradayContext } from '@/services/t-score/intraday';
import { computeTScore } from '@/services/t-score/scorer';
import { finetuneTScore } from '@/services/t-score/browser-finetune';
import { calculateIndicators } from '@/lib/indicators';
import { isETF } from '@/lib/identify';
import { getVolScale } from '@/lib/volatility-regime';
import { cn } from '@/lib/utils';
import { buildUpdatedKLines } from '@/lib/stock-helpers';
import { Brain, Settings, Loader2, Sparkles, Send, Search } from 'lucide-react';
import { postJSON } from '@/services/api';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Tabs } from '@/components/ui/tabs';
import { PageHeader } from '@/components/ui/page-header';
import { Input, Select } from '@/components/ui/input';
import { ProfileSettingsModal } from '@/components/ai/ProfileSettingsModal';
import { ProfileFormModal } from '@/components/ai/ProfileFormModal';
import { AnalysisHistory } from '@/components/ai/AnalysisHistory';
import { AiChat } from '@/components/ai/AiChat';
import { ReasoningPanel } from '@/components/ai/ReasoningPanel';

/** 深度分析降级标记 → 友好中文（warnings 数组里是 engine 的代码段名） */
const WARN_LABELS: Record<string, string> = {
  analyst: '情报收集',
  tech: '技术分析师', risk: '风控专家', xinjie: '心姐',
  tech_r2: '技术分析师反驳', risk_r2: '风控专家反驳', xinjie_r2: '心姐反驳',
  verdict_attempt1: '完整版裁决', verdict_attempt2: '降级版裁决', verdict_attempt3: '极简版裁决',
  fallback_rule: 'AI 裁决',
  server_verdict_failed: '服务器裁决',
  rate_limited: '接口限流',
};
/** 辩论角色阶段键（判定辩论是否部分失败） */
const DEBATE_ROLE_KEYS = ['tech', 'risk', 'xinjie', 'tech_r2', 'risk_r2', 'xinjie_r2'];
import { TScorePanel, type TScorePanelResult } from '@/components/ai/TScorePanel';
import { StockTrackStrip, VerdictCalibrationNote } from '@/components/ai/DeepCalibration';
import { TermTooltip } from '@/components/ui/TermTooltip';
import { generateId } from '@/components/ai/shared';
import {
  prepareDeepContext, runDeepAnalysisStream, buildDeepSummary, buildDeepSuggestion, saveDeepEval,
  loadDeepResume, clearDeepResume,
} from '@/services/deep-analysis/engine';
import type { DeepResult, DeepStage } from '@/services/deep-analysis/types';

/** 波段评分结果（客户端算的因子分 + 路由返回的 LLM 微调合并） */
type TScoreResult = TScorePanelResult;

/**
 * 深度分析进度估算：每阶段一个基准区间，阶段内按已流式字符数（内容+思考链）插值。
 * 估算值只增不减；断点续传跳过已完成阶段时基准自动跳段。
 */
const DEEP_STAGE_PLAN: Record<DeepStage, { base: number; span: number; expect: number }> = {
  idle:    { base: 2,  span: 0,  expect: 1 },
  analyst: { base: 4,  span: 30, expect: 1800 },
  debate:  { base: 36, span: 30, expect: 2800 },
  verdict: { base: 68, span: 29, expect: 1600 },
};

export default function AiPage() {
  const { watchlist } = useStockStore();
  const aiStore = useAiStore();
  const { profiles, currentProfileId, history } = aiStore;

  const [showSettings, setShowSettings] = useState(false);
  const [showAddProfile, setShowAddProfile] = useState(false);
  const [mode, setMode] = useState<'analyze'>('analyze');
  // 页面级主视图：分析 / AI 对话（整页互斥切换，对话是独立大界面）；位置存 ui-store 防重挂载丢失
  const mainTab = useUiStore(s => s.aiMainTab);
  const setMainTab = useUiStore(s => s.setAiMainTab);
  const [editingProfile, setEditingProfile] = useState<AiProfile | null>(null);
  const [selectedCode, setSelectedCode] = useState<string>(aiStore.lastSession?.selectedCode ?? '');
  // 搜索选中的非自选标的（自选内标的为 null）；随 lastSession 持久化
  const [extraStock, setExtraStock] = useState<Stock | null>(
    aiStore.lastSession?.extraStock ?? null
  );
  const [stockQuery, setStockQuery] = useState('');
  const [searchResults, setSearchResults] = useState<{ code: string; name: string }[]>([]);
  const [searching, setSearching] = useState(false);
  const [showSearchList, setShowSearchList] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [result, setResult] = useState<TScoreResult | null>(aiStore.lastSession?.result ?? null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [isDeepAnalyzing, setIsDeepAnalyzing] = useState(false);
  const [deepStage, setDeepStage] = useState<DeepStage>('idle');
  const [deepResult, setDeepResult] = useState<DeepResult | null>(aiStore.lastSession?.deepResult ?? null);
  const deepAbortRef = useRef<AbortController | null>(null);
  // 断点续传：记录已完成阶段的输出文本 { analyst, tech, risk, ... }
  const [deepCompleted, setDeepCompleted] = useState<Record<string, string>>({});
  // 断点恢复：页面加载时若有未完成的深度分析（7 天内），提示可继续生成
  useEffect(() => {
    const resume = loadDeepResume();
    if (resume && resume.stockCode === selectedCode && Object.keys(resume.completed).length > 0) {
      setDeepCompleted(resume.completed);
      setError('检测到上次未完成的分析，可点击右侧按钮从断点继续');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 用户看法（加入辩论，降低权重，防AI迎合）
  const [userView, setUserView] = useState<string>(aiStore.lastSession?.userView ?? '');
  const [userViewReason, setUserViewReason] = useState<string>(aiStore.lastSession?.userViewReason ?? '');

  // 轻量 state 同步到 lastSession（result/deepResult 流式频繁，在完成回调里单独同步，避免每 token 写 localStorage）
  useEffect(() => {
    aiStore.updateLastSession({ selectedCode, userView, userViewReason, extraStock });
  }, [selectedCode, userView, userViewReason, extraStock]);

  // 标的搜索防抖：本地缓存优先，无结果走服务端兜底（setState 全部放回调里，避免 effect 体内同步 setState）
  useEffect(() => {
    const kw = stockQuery.trim();
    let cancelled = false;
    const t = setTimeout(async () => {
      if (!kw) {
        if (!cancelled) { setSearchResults([]); setSearching(false); }
        return;
      }
      setSearching(true);
      const r = await searchStocks(kw);
      if (!cancelled) {
        setSearchResults(r.map(q => ({ code: q.code, name: q.name })));
        setSearching(false);
        setShowSearchList(true);
      }
    }, kw ? 300 : 0);
    return () => { cancelled = true; clearTimeout(t); };
  }, [stockQuery]);

  /** 解析当前选中标的：优先自选，其次搜索选中的临时标的 */
  const resolveStock = (): Stock | undefined => {
    const w = watchlist.find(s => s.code === selectedCode);
    if (w) return w;
    if (extraStock && extraStock.code === selectedCode) return extraStock;
    return undefined;
  };

  // 传给 AI 对话的列表：附带搜索临时标的，保证名称查找/对比 chip 正常
  const effectiveWatchlist = useMemo(() => {
    if (extraStock && !watchlist.some(w => w.code === extraStock.code)) return [...watchlist, extraStock];
    return watchlist;
  }, [watchlist, extraStock]);

  const pickSearchedStock = (code: string, name: string) => {
    const parsed = parseStockCode(code);
    setExtraStock({ code, name, market: parsed.market, pureCode: parsed.pureCode });
    setSelectedCode(code);
    setStockQuery('');
    setSearchResults([]);
    setShowSearchList(false);
    setError(null);
    setResult(null);
    // 深度结论随标的走：换标的必须清掉，否则残留上一只的结论（AI 对话注入会张冠李戴）
    setDeepResult(null);
    aiStore.updateLastSession({ deepResult: null });
  };

  // 波段评分 result 非流式（一次性算完），直接 useEffect 同步，覆盖 set 与清空
  useEffect(() => {
    aiStore.updateLastSession({ result });
  }, [result]);

  const currentProfile = profiles.find(p => p.id === currentProfileId);

  const openAddProfile = () => {
    setEditingProfile(null);
    setShowSettings(false);
    setShowAddProfile(true);
  };

  const openEditProfile = (p: AiProfile) => {
    setEditingProfile(p);
    setShowSettings(false);
    setShowAddProfile(true);
  };

  // 波段评分（替换原心姐快速分析）
  const runTScore = async () => {
    if (!selectedCode || !currentProfile) {
      toast.error('请先选择标的');
      return;
    }

    const stock = resolveStock();
    if (!stock) {
      toast.error('请先选择标的');
      return;
    }

    setIsAnalyzing(true);
    setError(null);
    setResult(null);
    setDeepResult(null);

    const abortController = new AbortController();
    abortRef.current = abortController;

    try {
      const [quote, kLines, minute, chip] = await Promise.all([
        getRealtimeQuote(selectedCode),
        getKLineSina(selectedCode, 240, 120),
        getMinuteDataCached(selectedCode),
        getChipData(selectedCode).catch(() => null),
      ]);

      if (!quote) throw new Error('获取行情失败');

      const updatedKLines = kLines.length >= 5 ? buildUpdatedKLines(quote, kLines) : kLines;
      const engineResults = checkAllRules(updatedKLines, quote, ALERT_RULES.filter(r => r.isEnabled), chip, undefined, isETF(selectedCode));
      const indDaily = calculateIndicators(updatedKLines);
      const intraday = buildIntradayContext(minute);
      const marketNote = await fetchMarketStatusNote();
      const marketOpen = marketNote.includes('交易中');

      // 分时不足或市场闭市 → degraded，不算分不调 LLM
      if (!intraday.sufficient || !marketOpen) {
        setResult({
          degraded: true,
          degradation: [...(intraday.sufficient ? [] : ['intraday_insufficient']), ...(!marketOpen ? ['market_closed'] : [])],
          buyScore: 0, sellScore: 0, buyFactors: [], sellFactors: [],
          intraday, engineResults,
          finalBuy: 0, finalSell: 0, buyAdjust: 0, sellAdjust: 0,
          buyReason: '', sellReason: '', analysis: '', confidence: 0, tags: [],
          llmAdjusted: false, coverage: null,
        });
        toast.error(!marketOpen ? '市场已闭市，波段评分需在交易时段使用' : '分时数据不足，暂无法评分');
        return;
      }

      // 确定性因子分（ETF 按波动档缩放幅度类参数）
      const t = computeTScore(
        { intraday, engineResults, chip, kLines: updatedKLines },
        isETF(selectedCode) ? getVolScale(updatedKLines) : 1
      );
      // 因子分在线落库（做T信号回测样本，静默失败不阻断；同票同日同时刻覆盖）
      try {
        const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(/-/g, '');
        fetch('/api/tscore/records', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tsCode: selectedCode, stockName: stock.name,
            tradeDate: todayStr, minuteOfDay: intraday.minuteOfDay ?? null,
            price: quote.price, buyScore: t.buyScore, sellScore: t.sellScore,
            buyFactors: t.buyFactors, sellFactors: t.sellFactors, degraded: t.degraded,
          }),
        }).catch(() => {});
      } catch { /* 落库失败不阻断评分 */ }
      // 先把因子分结果显示出来（LLM 微调前）
      setResult({
        degraded: false, degradation: t.degradation,
        buyScore: t.buyScore, sellScore: t.sellScore, buyFactors: t.buyFactors, sellFactors: t.sellFactors,
        intraday, engineResults,
        finalBuy: t.buyScore, finalSell: t.sellScore, buyAdjust: 0, sellAdjust: 0,
        buyReason: '', sellReason: '', analysis: '', confidence: 0, tags: [],
        llmAdjusted: false, coverage: null,
      });

      // LLM 微调
      const systemPrompt = buildTscoreSystemPrompt(isETF(selectedCode));
      const userPrompt = buildTscoreUserPrompt({
        stockName: stock.name, code: selectedCode, ctx: intraday, indDaily, engineResults, chip,
        buyScore: t.buyScore, sellScore: t.sellScore, buyFactors: t.buyFactors, sellFactors: t.sellFactors,
        positionPercent: stock.positionPercent, marketNote: `[市场状态] ${marketNote}`,
      });

      const data = await finetuneTScore({
        systemPrompt, userPrompt,
        cfg: { baseUrl: currentProfile.baseUrl, apiKey: currentProfile.apiKey, model: currentProfile.model },
        buyScore: t.buyScore, sellScore: t.sellScore,
        signal: abortController.signal,
      });

      const final: TScoreResult = {
        degraded: false, degradation: t.degradation,
        buyScore: t.buyScore, sellScore: t.sellScore, buyFactors: t.buyFactors, sellFactors: t.sellFactors,
        intraday, engineResults,
        finalBuy: data.finalBuy, finalSell: data.finalSell,
        buyAdjust: data.buyAdjust, sellAdjust: data.sellAdjust,
        buyReason: data.buyReason || '', sellReason: data.sellReason || '',
        analysis: data.analysis || '', confidence: data.confidence ?? 0, tags: data.tags ?? [],
        llmAdjusted: !!data.llmAdjusted, coverage: data.coverage ?? null,
      };
      setResult(final);

      // 保存历史（兼容 AnalysisHistory 的 pill/字段）
      aiStore.addHistory({
        id: generateId(),
        stockCode: selectedCode,
        stockName: stock.name,
        profileName: currentProfile.name,
        model: currentProfile.model,
        riskLevel: final.finalBuy >= 70 ? '高信号' : final.finalBuy >= 40 ? '中信号' : '低信号',
        analysis: final.analysis || final.buyReason,
        suggestion: [final.buyReason, final.sellReason].filter(Boolean).join(' / '),
        triggeredRulesJson: JSON.stringify(final.engineResults.map(r => ({ ruleId: r.ruleId, message: r.message }))),
        supportPrice: String(intraday.vwap.toFixed(2)),
        resistancePrice: String(intraday.high.toFixed(2)),
        createdAt: Date.now(),
        buyScore: final.finalBuy, sellScore: final.finalSell,
        buyAdjust: final.buyAdjust, sellAdjust: final.sellAdjust,
        buyReason: final.buyReason, sellReason: final.sellReason,
        buyFactorsJson: JSON.stringify(final.buyFactors),
        sellFactorsJson: JSON.stringify(final.sellFactors),
        intradayJson: JSON.stringify(intraday),
        llmAdjusted: final.llmAdjusted,
      });

      toast.success('波段评分完成');
    } catch (err: any) {
      if (err.name === 'AbortError') {
        // 用户主动取消，不显示错误
      } else {
        const msg = err.message || '评分失败';
        setError(msg);
        toast.error(msg);
      }
    } finally {
      setIsAnalyzing(false);
      abortRef.current = null;
    }
  };

  // 深度分析（三阶段）。resumeCompleted 传入时为断点续传，跳过已完成阶段
  const runDeepAnalysis = async (resumeCompleted?: Record<string, string>) => {
    if (!resumeCompleted) clearDeepResume(); // 全新分析，清掉历史断点（续传不清）
    if (!selectedCode || !currentProfile) {
      toast.error('请先选择标的');
      return;
    }
    if (isAnalyzing) return;

    const stock = resolveStock();
    if (!stock) {
      toast.error('请先选择标的');
      return;
    }

    setIsDeepAnalyzing(true);
    setError(null);
    setDeepResult(null);
    setDeepStage('idle');
    setResult(null);

    const abortController = new AbortController();
    deepAbortRef.current = abortController;

    try {
      // 数据准备（抓行情/K线/筹码 + 算指标 + 拼三阶段 prompt）
      const ctx = await prepareDeepContext(selectedCode, stock, history);
      if (ctx.tushareIssues.length > 0) {
        toast.warning(`基本面数据部分缺失：${ctx.tushareIssues.join('；')}`);
      }

      // 网络波动自动续跑：非用户取消的失败且有断点进度时，自动从断点重试（最多 2 次）
      const MAX_AUTO_RESUME = 2;
      let resumeCur = resumeCompleted;
      let outcome: Awaited<ReturnType<typeof runDeepAnalysisStream>> | null = null;
      for (let attempt = 0; attempt <= MAX_AUTO_RESUME; attempt++) {
        try {
          // SSE 流式三阶段分析
          outcome = await runDeepAnalysisStream({
            ctx,
            cfg: { baseUrl: currentProfile.baseUrl, apiKey: currentProfile.apiKey, model: currentProfile.model },
            resumeCompleted: resumeCur,
            userView: userView || undefined,
            userViewReason: userViewReason || undefined,
            signal: abortController.signal,
            onProgress: (p) => {
              setDeepStage(p.stage);
              setDeepResult(p.result);
            },
          });
          break;
        } catch (e: any) {
          if (e.name === 'AbortError' || abortController.signal.aborted) throw e;
          const resume = loadDeepResume();
          const hasProgress = !!resume && resume.stockCode === selectedCode && Object.keys(resume.completed).length > 0;
          if (!hasProgress || attempt >= MAX_AUTO_RESUME) throw e;
          resumeCur = { ...resume.completed };
          toast.info(`网络波动，正在自动续跑…（${attempt + 1}/${MAX_AUTO_RESUME}）`);
          await new Promise(r => setTimeout(r, 2500 * (attempt + 1)));
          if (abortController.signal.aborted) {
            const abortErr = new Error('cancelled');
            abortErr.name = 'AbortError';
            throw abortErr;
          }
        }
      }
      if (!outcome) throw new Error('深度分析失败');
      const { result: finalResult } = outcome;
      const isDegraded = !!finalResult.warnings && finalResult.warnings.length > 0;

      // 保存深度分析历史（残缺分析打标记，本地也能看出不完整）
      aiStore.addHistory({
        id: generateId(),
        stockCode: selectedCode,
        stockName: stock.name,
        profileName: currentProfile.name,
        model: currentProfile.model,
        riskLevel: finalResult.structured?.action || '深度分析',
        analysis: (isDegraded ? '[内容不完整] ' : '') + buildDeepSummary(finalResult),
        suggestion: buildDeepSuggestion(finalResult.structured),
        triggeredRulesJson: JSON.stringify([]),
        supportPrice: String(finalResult.structured?.targetLow ?? ''),
        resistancePrice: String(finalResult.structured?.targetHigh ?? ''),
        createdAt: Date.now(),
        entryDate: ctx.entryDate,
      });

      // 全局回测落库（匿名，失败不阻断）。残缺分析（任一阶段失败/降级/规则兜底）不落库——
      // 否则这类"未经验证的残缺建议"会进 T+N 回测与胜率复盘，污染统计口径。
      if (!isDegraded) {
        saveDeepEval({
          stockCode: selectedCode, stockName: stock.name,
          entryDate: ctx.entryDate, entryPrice: ctx.quote.price,
          structured: finalResult.structured,
          marketRegime: ctx.marketRegime,
        });
      }

      // 持久化最终结果（避开 state 异步；流式中间态不写 localStorage）
      aiStore.updateLastSession({ deepResult: finalResult });

      if (isDegraded) {
        toast.warning('本次分析部分内容生成失败，结果可能不完整，请留意标注');
      } else {
        toast.success('深度分析完成');
      }
      setDeepCompleted({});
    } catch (err: any) {
      if (err.name === 'AbortError') {
        // 用户主动取消
      } else {
        const msg = err.message || '深度分析失败';
        setError(msg);
        toast.error(msg);
        // 失败后从持久化恢复断点（engine 已保存），"继续生成"按钮据此显示
        const resume = loadDeepResume();
        setDeepCompleted(resume && resume.stockCode === selectedCode ? resume.completed : {});
      }
    } finally {
      setIsDeepAnalyzing(false);
      setDeepStage('idle');
      deepAbortRef.current = null;
    }
  };

  const cancelAnalysis = () => {
    if (abortRef.current) abortRef.current.abort();
    if (deepAbortRef.current) deepAbortRef.current.abort();
  };

  // 当前阶段已流式字符数（内容+思考链）→ 进度百分比
  const deepStageChars =
    deepStage === 'analyst' ? (deepResult?.analyst?.length ?? 0) + (deepResult?.analystReasoning?.length ?? 0)
    : deepStage === 'debate' ? (deepResult?.debate?.length ?? 0) + (deepResult?.debateReasoning?.length ?? 0)
    : deepStage === 'verdict' ? (deepResult?.verdict?.length ?? 0) + (deepResult?.verdictReasoning?.length ?? 0)
    : 0;
  const deepPlan = DEEP_STAGE_PLAN[deepStage];
  const deepProgress = Math.min(97, deepPlan.base + Math.min(deepStageChars / deepPlan.expect, 1) * deepPlan.span);

  return (
    <div>
      {/* 顶部 */}
      <PageHeader
        title="AI分析"
        icon={<Brain className="w-6 h-6 text-[var(--color-brand)]" />}
        actions={
          <button
            onClick={() => setShowSettings(true)}
            className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-[var(--radius-md)] transition"
          >
            <Settings className="w-5 h-5" />
          </button>
        }
      />

      {/* 大模型 API 配置框：分析 / 对话共用，恒显顶部 */}
      {currentProfile ? (
        <Card variant="bordered" className="mb-4 py-3 flex items-center justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{currentProfile.name}</p>
            <p className="text-xs text-gray-500 truncate">{currentProfile.model}</p>
          </div>
          <button
            onClick={() => setShowSettings(true)}
            className="text-xs text-[var(--color-accent)] hover:opacity-80 shrink-0 ml-3"
          >
            切换
          </button>
        </Card>
      ) : (
        <Card variant="accent" className="mb-4 text-center">
          <p className="text-sm text-[var(--color-brand)] mb-2">尚未配置API</p>
          <Button onClick={() => setShowSettings(true)}>添加API配置</Button>
        </Card>
      )}

      {/* 页面级主视图切换：分析 / AI 对话（API 框下方，样式对齐扫描页）；未配置 API 时置灰但可点 */}
      <div className={cn('mb-4', !currentProfile && 'opacity-60')}>
        <Tabs
          variant="segment"
          size="md"
          fullWidth
          items={[
            { value: 'analysis', label: '分析', icon: <Brain className="w-4 h-4" /> },
            { value: 'chat', label: 'AI 对话', icon: <Send className="w-4 h-4" /> },
          ]}
          value={mainTab}
          onChange={(v) => {
            if (!currentProfile) toast.error('请先配置 API');
            setMainTab(v);
          }}
        />
      </div>

      {/* 门禁：未配置 API 时禁用全部 AI 功能 */}
      {!currentProfile && (
        <div className="text-center py-20 text-gray-400">
          <Brain className="w-16 h-16 mx-auto mb-4 opacity-20" />
          <p className="text-base">请先添加 API 配置后使用 AI 功能</p>
        </div>
      )}
      {currentProfile && mainTab === 'analysis' && (
      <>
      {/* ===== 个股分析模式 ===== */}
      {mode === 'analyze' && (
      <>
      {/* 股票选择 + 分析按钮（操作区） */}
      {currentProfile && (
      <Card variant="bordered" className="mb-4">
        <label className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2 block">
          选择标的
        </label>
        <Select
          value={selectedCode}
          onChange={(e) => {
            const v = e.target.value;
            setSelectedCode(v);
            if (v !== extraStock?.code) setExtraStock(null);
            setError(null); setResult(null);
            // 深度结论随标的走：换标的必须清掉（同 pickSearchedStock）
            setDeepResult(null);
            aiStore.updateLastSession({ deepResult: null });
          }}
          className="mb-2"
        >
          <option value="">-- 请选择自选标的 --</option>
          {extraStock && !watchlist.some(w => w.code === extraStock.code) && (
            <option value={extraStock.code}>{extraStock.name} ({extraStock.code}) · 搜索选中</option>
          )}
          {watchlist.map(stock => (
            <option key={stock.code} value={stock.code}>
              {stock.name} ({stock.code})
            </option>
          ))}
        </Select>

        {/* 任意标的搜索：非自选也能直接分析 */}
        <div className="relative mb-3">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
          <Input
            value={stockQuery}
            onChange={(e) => setStockQuery(e.target.value)}
            onFocus={() => { if (searchResults.length > 0) setShowSearchList(true); }}
            onBlur={() => setTimeout(() => setShowSearchList(false), 150)}
            placeholder="搜索代码/名称，非自选标的也能直接分析"
            className="pl-9"
          />
          {searching && (
            <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-gray-400" />
          )}
          {showSearchList && stockQuery.trim() && (
            <div className="absolute z-20 left-0 right-0 mt-1 max-h-56 overflow-y-auto bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-[var(--radius-md)] shadow-[var(--shadow-hover)]">
              {searchResults.length > 0 ? (
                searchResults.map(r => (
                  <button
                    key={r.code}
                    type="button"
                    onMouseDown={() => pickSearchedStock(r.code, r.name)}
                    className="w-full px-3 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center justify-between gap-2"
                  >
                    <span className="text-gray-800 dark:text-gray-200">{r.name}</span>
                    <span className="text-xs text-gray-400 font-mono">{r.code}</span>
                  </button>
                ))
              ) : (
                !searching && <p className="px-3 py-2 text-xs text-gray-400">无匹配结果</p>
              )}
            </div>
          )}
        </div>

        <div className="flex gap-2 mb-1">
          <Button
            onClick={runTScore}
            disabled={!selectedCode || isAnalyzing || isDeepAnalyzing}
            loading={isAnalyzing}
            variant="primary"
            className="flex-1"
          >
            {isAnalyzing ? '评分中...' : '波段评分'}
          </Button>
          <Button
            onClick={() => runDeepAnalysis()}
            disabled={!selectedCode || isAnalyzing || isDeepAnalyzing}
            loading={isDeepAnalyzing}
            variant="accent"
            className="flex-1"
          >
            {isDeepAnalyzing ? '深度分析中...' : '深度分析'}
          </Button>
        </div>

        {/* 深度分析提示已删：耗时与 Token 成本由裁决页自行感知 */}

        {/* P1：本票历史战绩条（有深度分析落库记录才显示） */}
        <StockTrackStrip stockCode={selectedCode} />

        {/* 用户看法（加入辩论，AI会验证但不迎合） */}
        <div className="flex flex-wrap items-center gap-2 mb-1 text-xs">
          <span className="text-gray-500">你的看法（可选）：</span>
          {['看空', '中性', '看多'].map(v => (
            <button key={v} onClick={() => setUserView(prev => prev === v ? '' : v)}
              className={cn("px-2.5 py-1 rounded-[var(--radius-md)] font-medium transition",
                userView === v
                  ? v === '看多' ? "bg-[var(--color-up-soft)] text-[var(--color-up)]" : v === '看空' ? "bg-[var(--color-down-soft)] text-[var(--color-down)]" : "bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300"
                  : "bg-gray-100 dark:bg-gray-800 text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700")}>
              {v}
            </button>
          ))}
          {userView && (
            <Input type="text" value={userViewReason} onChange={e => setUserViewReason(e.target.value)}
              placeholder="理由（可选，如：业绩超预期、板块龙头）"
              block={false}
              className="flex-1 min-w-[150px] py-1 text-xs" />
          )}
        </div>

        {(isAnalyzing || isDeepAnalyzing) && (
          <button
            onClick={cancelAnalysis}
            className="w-full py-2 text-sm text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)] rounded-[var(--radius-md)] transition"
          >
            取消分析
          </button>
        )}
      </Card>
      )}

      {/* 结果区与操作区视觉分隔 */}
      {(result || deepResult || isDeepAnalyzing || error) && (
        <div className="border-t border-gray-200 dark:border-gray-800 my-[var(--space-section)]" />
      )}

      {/* 错误 */}
      {error && (
        <div className="bg-[var(--color-danger-soft)] border border-[var(--color-up-border)] rounded-[var(--radius-lg)] p-4 mb-4 text-[var(--color-danger)] text-sm">
          {error}
          {!isDeepAnalyzing && Object.keys(deepCompleted).length > 0 && (
            <button
              onClick={() => runDeepAnalysis(deepCompleted)}
              className="ml-2 px-3 py-1 bg-[var(--color-danger)] text-white rounded-[var(--radius-md)] text-xs font-medium hover:opacity-90 transition"
            >
              继续生成（从断点恢复）
            </button>
          )}
        </div>
      )}

      {/* 波段评分结果 */}
      {result && (
        <div className="mb-6">
          <TScorePanel result={result} isRunning={isAnalyzing} />
        </div>
      )}

      {/* ======= 深度分析结果 ======= */}
      {(deepResult || isDeepAnalyzing) && (
        <div className="space-y-4 mb-6">
          {/* 阶段进度指示器 */}
          {isDeepAnalyzing && (
            <div className="bg-white dark:bg-gray-900 rounded-xl p-4 shadow-sm">
              <div className="flex items-center justify-center gap-2 text-xs">
                <div className={cn(
                  "flex items-center gap-1 px-2.5 py-1.5 rounded-full transition",
                  deepStage === 'analyst' ? "bg-blue-100 text-blue-700" :
                  deepStage === 'debate' || deepStage === 'verdict' ? "bg-blue-50 text-blue-600" :
                  "bg-gray-100 text-gray-500"
                )}>
                  <span className={cn("w-1.5 h-1.5 rounded-full",
                    deepStage === 'analyst' ? "bg-blue-500 animate-pulse" :
                    deepStage === 'debate' || deepStage === 'verdict' ? "bg-blue-500" : "bg-gray-300"
                  )} />
                  情报收集
                </div>
                <span className="text-gray-300">→</span>
                <div className={cn(
                  "flex items-center gap-1 px-2.5 py-1.5 rounded-full transition",
                  deepStage === 'debate' ? "bg-amber-100 text-amber-700" :
                  deepStage === 'verdict' ? "bg-amber-50 text-amber-600" :
                  "bg-gray-100 text-gray-500"
                )}>
                  <span className={cn("w-1.5 h-1.5 rounded-full",
                    deepStage === 'debate' ? "bg-amber-500 animate-pulse" :
                    deepStage === 'verdict' ? "bg-amber-500" : "bg-gray-300"
                  )} />
                  多空辩论
                </div>
                <span className="text-gray-300">→</span>
                <div className={cn(
                  "flex items-center gap-1 px-2.5 py-1.5 rounded-full transition",
                  deepStage === 'verdict' ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"
                )}>
                  <span className={cn("w-1.5 h-1.5 rounded-full",
                    deepStage === 'verdict' ? "bg-green-500 animate-pulse" : "bg-gray-300"
                  )} />
                  最终裁决
                </div>
              </div>

              {/* 进度条：颜色随阶段（情报蓝/辩论黄/裁决绿），宽度随流式输出平滑推进 */}
              <div className="mt-3 flex items-center gap-2">
                <div className="flex-1 h-1.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                  <div
                    className={cn(
                      "h-full rounded-full transition-[width] duration-500 ease-out",
                      deepStage === 'analyst' ? "bg-blue-500" :
                      deepStage === 'debate' ? "bg-amber-500" : "bg-green-500"
                    )}
                    style={{ width: `${deepProgress}%` }}
                  />
                </div>
                <span className="text-xs text-gray-400 tabular-nums w-8 text-right">{Math.round(deepProgress)}%</span>
              </div>
            </div>
          )}

          {/* 阶段一：情报分析（失败也展示标注，不让用户误以为正常） */}
          {(deepResult?.analyst || deepResult?.warnings?.includes('analyst')) && (
            <div className="bg-white dark:bg-gray-900 rounded-xl p-4 shadow-sm">
              <h3 className="font-semibold mb-3 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-blue-500" />
                阶段一：情报分析
              </h3>
              {deepResult?.warnings?.includes('analyst') ? (
                <div className="text-xs text-amber-600 p-2 bg-amber-50 dark:bg-amber-950 rounded">
                  ⚠️ 情报收集生成失败，已跳过。本次分析基于其余数据完成，结果可能不完整。
                </div>
              ) : (
                <>
                  <div className="text-sm text-gray-600 dark:text-gray-400 whitespace-pre-wrap leading-relaxed">
                    {deepResult.analyst}
                    {isDeepAnalyzing && !deepResult?.analystDone && (
                      <span className="text-blue-500 animate-pulse text-lg font-bold">···</span>
                    )}
                  </div>
                  <ReasoningPanel
                    reasoning={deepResult.analystReasoning || ''}
                    isStreaming={isDeepAnalyzing && !deepResult?.analystDone}
                  />
                </>
              )}
            </div>
          )}
          {isDeepAnalyzing && deepStage === 'debate' && !deepResult?.debate && (
            <div className="flex items-center gap-2 text-base text-blue-500 font-medium py-2">
              <Loader2 className="w-5 h-5 animate-spin" />
              等待辩论...
            </div>
          )}

          {/* 阶段二：多空辩论 */}
          {(deepResult?.debate || deepResult?.debateError || deepResult?.warnings?.some((w) => DEBATE_ROLE_KEYS.includes(w)) || (isDeepAnalyzing && (deepStage === 'debate' || deepStage === 'verdict'))) && (
            <div className="bg-white dark:bg-gray-900 rounded-xl p-4 shadow-sm">
              <h3 className="font-semibold mb-3 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-amber-500" />
                阶段二：多空辩论
              </h3>
              {deepResult?.debateError && (
                <div className="text-xs text-amber-600 mb-2 p-2 bg-amber-50 dark:bg-amber-950 rounded">{deepResult.debateError}</div>
              )}
              {/* 辩论部分失败就地标注 */}
              {(() => {
                const failed = DEBATE_ROLE_KEYS.filter((k) => deepResult?.warnings?.includes(k));
                if (failed.length > 0) {
                  return (
                    <div className="text-xs text-amber-600 mb-2 p-2 bg-amber-50 dark:bg-amber-950 rounded">
                      ⚠️ 辩论部分角色生成失败已跳过（{failed.map((k) => WARN_LABELS[k] ?? k).join('、')}），辩论不完整。
                    </div>
                  );
                }
                return null;
              })()}
              {deepResult?.debate ? (
                <div className="text-sm text-gray-600 dark:text-gray-400 whitespace-pre-wrap leading-relaxed">
                  {deepResult.debate}
                  {isDeepAnalyzing && !deepResult?.debateDone && (
                    <span className="text-amber-500 animate-pulse">...</span>
                  )}
                </div>
              ) : isDeepAnalyzing && (deepStage === 'debate' || deepStage === 'verdict') ? (
                <div className="text-sm text-gray-400 animate-pulse">等待辩论结果...</div>
              ) : deepResult?.warnings?.some((w) => DEBATE_ROLE_KEYS.includes(w)) ? (
                <div className="text-sm text-amber-600 p-2 bg-amber-50 dark:bg-amber-950 rounded">辩论全部生成失败，已跳过。</div>
              ) : null}
              <ReasoningPanel
                reasoning={deepResult?.debateReasoning || ''}
                isStreaming={isDeepAnalyzing && !deepResult?.debateDone}
              />
            </div>
          )}
          {isDeepAnalyzing && deepStage === 'verdict' && !deepResult?.verdict && (
            <div className="flex items-center gap-2 text-sm text-gray-400 pl-4">
              <Loader2 className="w-4 h-4 animate-spin" />
              等待最终裁决...
            </div>
          )}

          {/* 阶段三：最终裁决 */}
          {(deepResult?.verdict || deepResult?.verdictError || deepResult?.structured || deepStage === 'verdict') && (
            <div className="bg-white dark:bg-gray-900 rounded-xl p-4 shadow-sm border-l-4 border-green-500">
              <h3 className="font-semibold mb-3 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-green-500" />
                阶段三：最终裁决
              </h3>
              {deepResult?.verdictError && (
                <div className="text-xs text-red-600 mb-2 p-2 bg-red-50 dark:bg-red-950 rounded">{deepResult.verdictError}</div>
              )}
              {/* 降级提示：上游角色被跳过/裁决降级/规则兜底——告诉用户这份分析不完整；
                  rate_limited 不算失败（已自动排队串行，结果完整），单独措辞 */}
              {deepResult?.warnings && deepResult.warnings.length > 0 && (() => {
                const rateLimited = deepResult.warnings.includes('rate_limited');
                const failed = deepResult.warnings.filter((w) => w !== 'rate_limited');
                if (failed.length === 0) {
                  return (
                    <div className="text-xs mb-2 p-2 rounded text-amber-600 bg-amber-50 dark:bg-amber-950">
                      ⚠️ 接口并发受限，已自动切换排队模式——生成较慢，但结果完整
                    </div>
                  );
                }
                return (
                  <div className={cn(
                    'text-xs mb-2 p-2 rounded',
                    failed.includes('fallback_rule')
                      ? 'text-red-600 bg-red-50 dark:bg-red-950'
                      : 'text-amber-600 bg-amber-50 dark:bg-amber-950'
                  )}>
                    {failed.includes('fallback_rule')
                      ? '⚠️ 本次分析未能完成，以下为规则兜底结果，仅供参考'
                      : `⚠️ 分析不完整：${failed.map((w) => WARN_LABELS[w] ?? w).join('、')} 生成失败已跳过，已基于现有数据完成决策`}
                    {rateLimited && '（另：接口并发受限，已自动排队处理）'}
                  </div>
                );
              })()}

              {/* 结构化决策卡片 */}
              {deepResult?.structured?.action ? (
                <div className={cn(
                  "rounded-xl p-4 mb-4",
                  deepResult.structured.action === '买入' ? "bg-red-50 dark:bg-red-950 border border-red-200" :
                  deepResult.structured.action === '卖出' ? "bg-green-50 dark:bg-green-950 border border-green-200" :
                  "bg-gray-50 dark:bg-gray-950 border border-gray-200"
                )}>
                  {deepResult.structured.oneLiner && (
                    <p className={cn(
                      "text-base font-semibold mb-3 leading-relaxed",
                      deepResult.structured.action === '买入' ? "text-red-600 dark:text-red-400" :
                      deepResult.structured.action === '卖出' ? "text-green-600 dark:text-green-400" :
                      "text-gray-600 dark:text-gray-300"
                    )}>
                      💬 {deepResult.structured.oneLiner}
                    </p>
                  )}
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <span className="text-gray-500 text-xs">操作</span>
                      <p className="text-xl font-bold">{deepResult.structured.action}</p>
                    </div>
                    <div>
                      <span className="text-gray-500 text-xs"><TermTooltip term="风险等级" explain="综合技术面、基本面、仓位给出的整体风险评级：高/中/低。" /></span>
                      <p className="text-lg font-semibold">{deepResult.structured.riskLevel}</p>
                    </div>
                    <div>
                      <span className="text-gray-500 text-xs"><TermTooltip term="建议仓位" explain="建议投入总资金的比例。加仓场景下为加仓后的总仓位目标。" /></span>
                      <p className="text-lg font-semibold">{Number.isFinite(deepResult.structured.position) ? `${deepResult.structured.position.toFixed(0)}%` : '--'}</p>
                    </div>
                    <div>
                      <span className="text-gray-500 text-xs"><TermTooltip term="目标价位" explain="预期上涨到的价格区间，到达后可考虑减仓兑现。基于前高/压力位推算。" /></span>
                      <p className="font-medium"><span className="text-green-600">{Number.isFinite(deepResult.structured.targetLow) ? deepResult.structured.targetLow.toFixed(2) : '--'}</span> - <span className="text-red-600">{Number.isFinite(deepResult.structured.targetHigh) ? deepResult.structured.targetHigh.toFixed(2) : '--'}</span></p>
                    </div>
                    <div>
                      <span className="text-gray-500 text-xs"><TermTooltip term="止损位" explain="跌破此价止损离场，控制亏损。基于支撑位和波动率推算。" /></span>
                      <p className="text-red-600 font-medium">{Number.isFinite(deepResult.structured.stopLoss) ? deepResult.structured.stopLoss.toFixed(2) : '--'}</p>
                    </div>
                  </div>

                  {/* P0：同类建议历史校准（数据在决策时刻出现） */}
                  <VerdictCalibrationNote
                    stockCode={selectedCode}
                    action={deepResult.structured.action}
                    confidence={deepResult.structured.confidence}
                  />

                  {/* 支撑压力位（结构位 + 黄金分割回撤） */}
                  {deepResult.levels && (deepResult.levels.supports.length > 0 || deepResult.levels.resistances.length > 0) && (
                    <div className="mt-3 pt-3 border-t border-gray-200/60 dark:border-gray-700/60">
                      <p className="text-xs text-gray-500 mb-1.5">支撑压力位 <span className="text-gray-400">（现价 {deepResult.levels.current.toFixed(2)}）</span></p>
                      <div className="grid grid-cols-2 gap-3 text-xs">
                        <div>
                          <p className="text-green-600 font-medium mb-1">支撑位</p>
                          <div className="flex flex-wrap gap-1.5">
                            {deepResult.levels.supports.map(l => (
                              <span key={`s-${l.label}-${l.price}`} className="px-1.5 py-0.5 rounded bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-400 font-mono text-[11px]">{l.label}</span>
                            ))}
                          </div>
                        </div>
                        <div>
                          <p className="text-red-600 font-medium mb-1">压力位</p>
                          <div className="flex flex-wrap gap-1.5">
                            {deepResult.levels.resistances.map(l => (
                              <span key={`r-${l.label}-${l.price}`} className="px-1.5 py-0.5 rounded bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-400 font-mono text-[11px]">{l.label}</span>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* 信心指数进度条 */}
                  {deepResult.structured.confidenceScore !== undefined && (
                    <div className="mt-3 pt-3 border-t border-gray-200/60 dark:border-gray-700/60">
                      <div className="flex items-center gap-2">
                        <span className="text-gray-500 text-xs w-16 shrink-0"><TermTooltip term="信心指数" explain="对判断的把握程度，越高越确定" /></span>
                        <div className="flex-1 h-2.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                          <div
                            className={cn(
                              "h-full rounded-full transition-all",
                              deepResult.structured.confidenceScore >= 0.7 ? "bg-green-500" :
                              deepResult.structured.confidenceScore >= 0.4 ? "bg-amber-500" : "bg-red-500"
                            )}
                            style={{ width: `${(deepResult.structured.confidenceScore * 100).toFixed(0)}%` }}
                          />
                        </div>
                        <span className="text-sm font-semibold w-10 text-right">
                          {(deepResult.structured.confidenceScore * 100).toFixed(0)}%
                        </span>
                      </div>
                    </div>
                  )}

                  {/* 关键要点 */}
                  {deepResult.structured.keyPoints && deepResult.structured.keyPoints.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-gray-200/60 dark:border-gray-700/60">
                      <h4 className="text-xs font-medium text-gray-500 mb-1.5">关键要点</h4>
                      <ul className="list-disc list-inside text-xs text-gray-600 dark:text-gray-400 space-y-0.5">
                        {deepResult.structured.keyPoints.map((point, i) => (
                          <li key={i}>{point}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              ) : isDeepAnalyzing && deepStage === 'verdict' ? (
                <div className="rounded-xl p-4 mb-4 bg-gray-50 dark:bg-gray-950 border border-gray-200 animate-pulse">
                  <p className="text-sm text-gray-500">正在生成决策...</p>
                </div>
              ) : null}

              {/* 综合评判（原研究经理职责已并入裁决） */}
              {deepResult?.structured?.consensus && (
                <div className="mb-3">
                  <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">综合评判</h4>
                  <p className="text-sm text-gray-600 dark:text-gray-400 whitespace-pre-wrap">{deepResult.structured.consensus}</p>
                </div>
              )}

              {/* 决策理由 */}
              {deepResult?.structured?.reasoning && (
                <div className="mb-3">
                  <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">决策理由</h4>
                  <p className="text-sm text-gray-600 dark:text-gray-400 whitespace-pre-wrap">{deepResult.structured.reasoning}</p>
                </div>
              )}

              {/* 操作计划 */}
              {deepResult?.structured?.plan && (
                <div className="mb-3">
                  <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">操作计划</h4>
                  <p className="text-sm text-gray-600 dark:text-gray-400 whitespace-pre-wrap">{deepResult.structured.plan}</p>
                </div>
              )}

              {/* 风险提示 */}
              {deepResult?.structured?.riskNote && (
                <div>
                  <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">风险提示</h4>
                  <p className="text-sm text-gray-600 dark:text-gray-400 whitespace-pre-wrap">{deepResult.structured.riskNote}</p>
                </div>
              )}

              {/* 流式中的闪烁光标 */}
              {isDeepAnalyzing && deepStage === 'verdict' && deepResult?.verdict && (
                <span className="inline-block w-0.5 h-4 bg-green-500 ml-0.5 animate-pulse align-middle" />
              )}

              <ReasoningPanel
                reasoning={deepResult?.verdictReasoning || ''}
                isStreaming={isDeepAnalyzing && deepStage === 'verdict'}
              />
            </div>
          )}
        </div>
      )}

      {/* 空状态 */}
      {!result && !isAnalyzing && !deepResult && !isDeepAnalyzing && !error && (
        <div className="text-center py-16 text-gray-400">
          <Brain className="w-16 h-16 mx-auto mb-4 opacity-20" />
          <p className="text-lg">选择标的开始AI分析</p>
        </div>
      )}

      {/* 历史分析：组件内部自持折叠态，默认折叠 */}
      <AnalysisHistory history={history} />

      </>
      )}
      </>
      )}
      {currentProfile && mainTab === 'chat' && (
        <AiChat
          currentProfile={currentProfile}
          selectedCode={selectedCode}
          watchlist={effectiveWatchlist}
          result={result}
          deepStructured={deepResult?.structured ?? null}
        />
      )}

      {/* 设置弹窗 */}
      {showSettings && (
        <ProfileSettingsModal
          onClose={() => setShowSettings(false)}
          onAdd={openAddProfile}
          onEdit={openEditProfile}
        />
      )}

      {/* 添加/编辑Profile弹窗 */}
      {showAddProfile && (
        <ProfileFormModal
          editingProfile={editingProfile}
          onClose={() => { setShowAddProfile(false); setEditingProfile(null); }}
        />
      )}
    </div>
  );
}
