'use client';

import { useState, useCallback, useRef } from 'react';
import { useStockStore } from '@/store';
import { useAiStore, AiProfile } from '@/store/ai-store';
import { getRealtimeQuote, getKLineSina, getRealtimeQuoteCached, getKLineSinaCached, getIndustry, fetchMarketStatusNote } from '@/services/stockApi';
import { ALERT_RULES, checkAllRules } from '@/services/alertRules';
import { buildXinJieQuickSystemPrompt } from '@/services/xinjiePrompt';
import { buildUserPrompt } from '@/services/aiPrompt';
import {
  buildAnalystSystemPrompt, buildAnalystUserPrompt,
  buildVerdictSystemPrompt, buildVerdictUserPrompt,
  buildReflectionContext, buildDebateDataPrompt,
} from '@/services/deepAnalysisPrompt';
import { calculateIndicators, formatIndicatorsForPrompt } from '@/lib/indicators';
import { isETF } from '@/lib/identify';
import { cn } from '@/lib/utils';
import { buildUpdatedKLines } from '@/lib/stock-helpers';
import { Brain, Settings, Loader2 } from 'lucide-react';
import { fetchTushareData, formatTushareForPrompt } from '@/services/tushareData';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ProfileSettingsModal } from '@/components/ai/ProfileSettingsModal';
import { ProfileFormModal } from '@/components/ai/ProfileFormModal';
import { AnalysisHistory } from '@/components/ai/AnalysisHistory';
import { AiChat } from '@/components/ai/AiChat';
import { generateId } from '@/components/ai/shared';

export default function AiPage() {
  const { watchlist } = useStockStore();
  const aiStore = useAiStore();
  const { profiles, currentProfileId, history } = aiStore;

  const [showSettings, setShowSettings] = useState(false);
  const [showAddProfile, setShowAddProfile] = useState(false);
  const [editingProfile, setEditingProfile] = useState<AiProfile | null>(null);
  const [selectedCode, setSelectedCode] = useState<string>('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [result, setResult] = useState<{
    riskLevel: string;
    analysis: string;
    suggestion: string;
    triggeredRules: any[];
    supportPrice: string;
    resistancePrice: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const [isDeepAnalyzing, setIsDeepAnalyzing] = useState(false);
  const [deepStage, setDeepStage] = useState<'idle' | 'analyst' | 'debate' | 'verdict'>('idle');
  const [deepResult, setDeepResult] = useState<{
    analyst: string;
    debate: string;
    debateError?: string;
    verdict: string;
    verdictError?: string;
    structured: {
      action: string;
      riskLevel: string;
      confidence: number;
      targetLow: string;
      targetHigh: string;
      stopLoss: string;
      position: string;
      reasoning: string;
      plan: string;
      riskNote: string;
      confidenceScore?: number;
      keyPoints?: string[];
    } | null;
  } | null>(null);
  const deepAbortRef = useRef<AbortController | null>(null);
  // 断点续传：记录已完成阶段的输出文本 { analyst, tech, risk, ... }
  const [deepCompleted, setDeepCompleted] = useState<Record<string, string>>({});

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

  // 从流式文本中逐步解析结构化字段
  const parseStreamContent = useCallback((text: string) => {
    const riskMatch = text.match(/RISK:(.+)/);
    const supportMatch = text.match(/SUPPORT:(.+)/);
    const resistanceMatch = text.match(/RESISTANCE:(.+)/);
    const rulesMatch = text.match(/RULES:(.+)/);

    // 按 --- 分割头部和正文
    const bodySplit = text.split(/^---[\r\n]+/m);
    let body = bodySplit.length > 1 ? bodySplit.slice(1).join('---\n') : text;

    let analysis = body;
    let suggestion = '';
    const suggIdx = body.indexOf('### 操作建议');
    if (suggIdx >= 0) {
      analysis = body.slice(0, suggIdx).replace(/^###\s*综合分析\s*\n?/m, '').trim();
      suggestion = body.slice(suggIdx).replace(/^###\s*操作建议\s*\n?/m, '').trim();
    } else {
      analysis = body.replace(/^###\s*综合分析\s*\n?/m, '').trim();
    }

    const rulesStr = rulesMatch?.[1]?.trim() || '';
    const triggeredRules = rulesStr && rulesStr !== '无'
      ? rulesStr.split(/[,，]/).filter(r => r.trim()).map(r => ({
          rule_name: r.trim(),
          level: 'WARNING' as const,
          detail: r.trim(),
        }))
      : [];

    return {
      riskLevel: riskMatch?.[1]?.trim() || '',
      supportPrice: supportMatch?.[1]?.trim() || '--',
      resistancePrice: resistanceMatch?.[1]?.trim() || '--',
      triggeredRules,
      analysis,
      suggestion,
    };
  }, []);

  // 从阶段三输出中解析结构化决策字段
  const parseVerdictContent = useCallback((text: string) => {
    const actionMatch = text.match(/ACTION:(.+)/);
    const riskMatch = text.match(/RISK_LEVEL:(.+)/);
    const confMatch = text.match(/CONFIDENCE:\s*(\d+)/);
    const confValue = confMatch ? parseInt(confMatch[1]) : 0;
    const confScoreValue = confValue / 100;
    const targetLowMatch = text.match(/TARGET_LOW:(.+)/);
    const targetHighMatch = text.match(/TARGET_HIGH:(.+)/);
    const stopMatch = text.match(/STOP_LOSS:(.+)/);
    const posMatch = text.match(/POSITION:(.+)/);
    const keyPointsMatch = text.match(/KEY_POINTS:\s*(.+)/);

    const bodySplit = text.split(/^---[\r\n]+/m);
    let body = bodySplit.length > 1 ? bodySplit.slice(1).join('---\n') : text;

    let reasoning = body, plan = '', riskNote = '';
    const planIdx = body.indexOf('### 操作计划');
    const riskIdx = body.indexOf('### 风险提示');

    if (planIdx >= 0) {
      reasoning = body.slice(0, planIdx).replace(/^###\s*决策理由\s*\n?/m, '').trim();
      if (riskIdx >= 0) {
        plan = body.slice(planIdx, riskIdx).replace(/^###\s*操作计划\s*\n?/m, '').trim();
        riskNote = body.slice(riskIdx).replace(/^###\s*风险提示\s*\n?/m, '').trim();
      } else {
        plan = body.slice(planIdx).replace(/^###\s*操作计划\s*\n?/m, '').trim();
      }
    } else {
      reasoning = body.replace(/^###\s*决策理由\s*\n?/m, '').trim();
    }

    return {
      action: actionMatch?.[1]?.trim() || '',
      riskLevel: riskMatch?.[1]?.trim() || '',
      confidence: parseInt(confMatch?.[1]?.trim() || '0'),
      targetLow: targetLowMatch?.[1]?.trim() || '--',
      targetHigh: targetHighMatch?.[1]?.trim() || '--',
      stopLoss: stopMatch?.[1]?.trim() || '--',
      position: posMatch?.[1]?.trim() || '--',
      reasoning, plan, riskNote,
      confidenceScore: confScoreValue,
      keyPoints: keyPointsMatch
        ? keyPointsMatch[1].split('|').map(p => p.trim()).filter(p => p.length > 0)
        : [],
    };
  }, []);

  // AI分析
  const runAnalysis = async () => {
    if (!selectedCode || !currentProfile) {
      toast.error('请先选择股票');
      return;
    }

    const stock = watchlist.find(s => s.code === selectedCode);
    if (!stock) {
      toast.error('股票不在自选列表中');
      return;
    }

    setIsAnalyzing(true);
    setError(null);
    setResult(null);
    setDeepResult(null);
    setStreamingText('');

    const abortController = new AbortController();
    abortRef.current = abortController;

    try {
      // 获取数据
      const [quote, kLines] = await Promise.all([
        getRealtimeQuote(selectedCode),
        getKLineSina(selectedCode, 240, 120),
      ]);

      if (!quote) throw new Error('获取行情失败');

      // 运行规则引擎
      const updatedKLines = kLines.length >= 5 ? buildUpdatedKLines(quote, kLines) : kLines;
      const engineResults = checkAllRules(updatedKLines, quote, ALERT_RULES.filter(r => r.isEnabled));
      const engineSummary = engineResults.length > 0
        ? engineResults.map(r => `${r.ruleId}:${r.message}`).join('; ')
        : '无触发规则';

      // 构建Prompt
      const quoteJson = JSON.stringify(quote, null, 2);
      const klineSummary = kLines.slice(-20).map(k =>
        `${k.date} ${k.open} ${k.high} ${k.low} ${k.close} ${k.volume}`
      ).join('\n');

      // 计算技术指标
      const indicatorResult = calculateIndicators(updatedKLines);
      const indicatorBlock = formatIndicatorsForPrompt(indicatorResult);

      // 持仓占比
      const positionNote = stock.positionPercent !== undefined
        ? `注意：该股票占用户总持仓的${stock.positionPercent}%，请在分析中考虑仓位集中度风险。`
        : undefined;

      const systemPrompt = buildXinJieQuickSystemPrompt(isETF(selectedCode));
      const marketNote = `[市场状态] ${await fetchMarketStatusNote()}\n\n`;
      const userPrompt = marketNote + buildUserPrompt(selectedCode, stock.name, quoteJson, klineSummary, engineSummary, indicatorBlock, positionNote);

      // SSE 流式调用AI代理
      const res = await fetch('/api/ai/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemPrompt,
          userPrompt,
          baseUrl: currentProfile.baseUrl,
          apiKey: currentProfile.apiKey,
          model: currentProfile.model,
        }),
        signal: abortController.signal,
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(errData.error || 'API请求失败');
      }

      // 读取 SSE 流
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      let sseBuffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;

          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') continue;

          try {
            const chunk = JSON.parse(data) as string;
            fullText += chunk;
            setStreamingText(fullText);

            // 实时更新结构化结果
            const parsed = parseStreamContent(fullText);
            setResult({
              riskLevel: parsed.riskLevel,
              analysis: parsed.analysis,
              suggestion: parsed.suggestion,
              triggeredRules: parsed.triggeredRules,
              supportPrice: parsed.supportPrice,
              resistancePrice: parsed.resistancePrice,
            });
          } catch {
            // 跳过无法解析的chunk
          }
        }
      }

      // 流结束，最终解析
      const final = parseStreamContent(fullText);
      const finalResult = {
        riskLevel: final.riskLevel || '未知',
        analysis: final.analysis || fullText || '(AI返回为空)',
        suggestion: final.suggestion || '',
        triggeredRules: final.triggeredRules,
        supportPrice: final.supportPrice,
        resistancePrice: final.resistancePrice,
      };

      setResult(finalResult);
      setStreamingText('');

      // 保存历史
      aiStore.addHistory({
        id: generateId(),
        stockCode: selectedCode,
        stockName: stock.name,
        profileName: currentProfile.name,
        model: currentProfile.model,
        riskLevel: finalResult.riskLevel,
        analysis: finalResult.analysis,
        suggestion: finalResult.suggestion,
        triggeredRulesJson: JSON.stringify(finalResult.triggeredRules),
        supportPrice: finalResult.supportPrice,
        resistancePrice: finalResult.resistancePrice,
        createdAt: Date.now(),
      });

      toast.success('AI分析完成');
    } catch (err: any) {
      if (err.name === 'AbortError') {
        // 用户主动取消，不显示错误
        setStreamingText('');
      } else {
        const msg = err.message || '分析失败';
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
    if (!selectedCode || !currentProfile) {
      toast.error('请先选择股票');
      return;
    }
    if (isAnalyzing) return;

    const stock = watchlist.find(s => s.code === selectedCode);
    if (!stock) {
      toast.error('股票不在自选列表中');
      return;
    }

    setIsDeepAnalyzing(true);
    setError(null);
    setDeepResult(null);
    setDeepStage('idle');
    setResult(null);

    const abortController = new AbortController();
    deepAbortRef.current = abortController;
    // 断点续传：记录本次运行中已完成的阶段文本
    const completedMap: Record<string, string> = {};

    try {
      // 获取数据（K线取60根，比心姐分析更多）
      const [quote, kLines, tushareData] = await Promise.all([
        getRealtimeQuoteCached(selectedCode),
        getKLineSinaCached(selectedCode, 240, 120),
        fetchTushareData(selectedCode).catch(async () => {
          console.warn('[Deep Analysis] Tushare 首次获取失败，2s 后重试...');
          await new Promise(r => setTimeout(r, 2000));
          return fetchTushareData(selectedCode).catch(() => null);
        }),
      ]);

      if (!quote) throw new Error('获取行情失败');

      // Tushare 部分接口失败/数据异常时，提示用户但不中断分析
      const tushareIssues = [
        ...(tushareData?.errors || []),
        ...(tushareData?.warnings || []),
      ];
      if (tushareIssues.length > 0) {
        toast.warning(`基本面数据部分缺失：${tushareIssues.join('；')}`);
      }

      // 格式化 Tushare 基本面数据
      const tushareBlock = formatTushareForPrompt(tushareData);

      // 运行规则引擎
      const updatedKLines = kLines.length >= 5 ? buildUpdatedKLines(quote, kLines) : kLines;
      const engineResults = checkAllRules(updatedKLines, quote, ALERT_RULES.filter(r => r.isEnabled));
      const engineSummary = engineResults.length > 0
        ? engineResults.map(r => `${r.ruleId}:${r.message}`).join('; ')
        : '无触发规则';

      const quoteJson = JSON.stringify(quote, null, 2);
      const klineSummary = kLines.slice(-60).map(k =>
        `${k.date} ${k.open} ${k.high} ${k.low} ${k.close} ${k.volume}`
      ).join('\n');

      // 计算技术指标
      const indicatorResult = calculateIndicators(updatedKLines);
      const indicatorBlock = formatIndicatorsForPrompt(indicatorResult);

      // 反思上下文（历史分析回顾）
      const reflectionBlock = buildReflectionContext(
        selectedCode,
        history,
        { price: quote.price, changePercent: quote.changePercent }
      );

      // 持仓占比
      const positionNote = stock.positionPercent !== undefined
        ? `注意：该股票占用户总持仓的${stock.positionPercent}%，请在分析中考虑仓位集中度风险。`
        : undefined;
      const positionNoteVerdict = stock.positionPercent !== undefined
        ? `用户当前持仓占比为${stock.positionPercent}%，请在仓位建议中考虑现有持仓，如需减持请明确说明。`
        : undefined;

      // 构建三阶段 prompts
      const marketStatusNote = `[市场状态] ${await fetchMarketStatusNote()}\n\n`;
      const etf = isETF(selectedCode);
      const stage1 = {
        systemPrompt: buildAnalystSystemPrompt(etf),
        userPrompt: marketStatusNote + buildAnalystUserPrompt(selectedCode, stock.name, quoteJson, klineSummary, engineSummary, indicatorBlock, reflectionBlock, positionNote, etf, tushareBlock, getIndustry(selectedCode)),
      };
      // Stage 2 辩论数据（路由自行处理角色分配和调用）
      const debateDataPrompt = buildDebateDataPrompt(selectedCode, stock.name, quoteJson, indicatorBlock, marketStatusNote);
      const stage2 = {
        systemPrompt: '', // 路由不再使用，自行构建角色 prompt
        userPrompt: debateDataPrompt,
      };
      // verdict 不需要完整 quoteJson（含 11 位成交额等裸大数，易触发中转站敏感信息风控），
      // 只给裁决必需的当前价/关键价位，用中文单位降低数字密度
      const compactQuote = `当前价 ${quote.price} 元，涨跌 ${quote.changePercent.toFixed(2)}%（昨收 ${quote.preClose}，开盘 ${quote.open}，最高 ${quote.high}，最低 ${quote.low}）`;
      const stage3 = {
        systemPrompt: buildVerdictSystemPrompt(),
        userPrompt: buildVerdictUserPrompt(selectedCode, stock.name, '', '', compactQuote, positionNoteVerdict),
      };

      // SSE 流式调用深度分析
      const res = await fetch('/api/ai/deep-analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stage1, stage2, stage3,
          baseUrl: currentProfile.baseUrl,
          apiKey: currentProfile.apiKey,
          model: currentProfile.model,
          completed: resumeCompleted,
        }),
        signal: abortController.signal,
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(errData.error || 'API请求失败');
      }

      // 读取 SSE 流
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = '';
      let analystText = '';
      let debateText = '';
      let debateError = '';
      let verdictText = '';
      let verdictError = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;

          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') continue;

          try {
            const msg = JSON.parse(data);

            if (msg.error && !msg.stage) {
              throw new Error(msg.error);
            }

            if (msg.stage === 'analyst') {
              if (msg.text !== undefined) {
                analystText += msg.text;
                setDeepStage('analyst');
                setDeepResult(prev => ({
                  ...(prev || { analyst: '', debate: '', verdict: '', structured: null }),
                  analyst: analystText,
                }));
              }
              if (msg.done) completedMap.analyst = analystText;
            }

            if (msg.stage === 'debate') {
              if (msg.role && msg.text !== undefined) {
                completedMap[msg.role] = msg.text.replace(/\n+$/, '');
              }
              if (msg.text !== undefined) {
                debateText += msg.text;
                setDeepStage('debate');
                setDeepResult(prev => ({
                  ...(prev || { analyst: analystText, debate: '', verdict: '', structured: null }),
                  debate: debateText,
                }));
              }
              if (msg.error) {
                debateError = msg.error;
                setDeepResult(prev => ({
                  ...(prev || { analyst: analystText, debate: '', verdict: '', structured: null }),
                  debateError: msg.error,
                }));
              }
            }

            if (msg.stage === 'verdict') {
              if (msg.text !== undefined) {
                verdictText += msg.text;
                setDeepStage('verdict');
                const parsed = parseVerdictContent(verdictText);
                setDeepResult(prev => ({
                  ...(prev || { analyst: analystText, debate: debateText, verdict: '', structured: null }),
                  verdict: verdictText,
                  structured: parsed,
                }));
              }
              if (msg.done) completedMap.verdict = verdictText;
              if (msg.error) {
                verdictError = msg.error;
                setDeepResult(prev => ({
                  ...(prev || { analyst: analystText, debate: debateText, verdict: '', structured: null }),
                  verdictError: msg.error,
                }));
              }
            }
          } catch (e: any) {
            // 解析消息失败，可能是 error 消息
            if (e.message && !e.message.includes('JSON')) {
              throw e;
            }
          }
        }
      }

      // 保存深度分析历史 —— 提取关键结论
      const finalStructured = parseVerdictContent(verdictText);

      // 提取辩论的综合评判
      let debateConclusion = '';
      const debateMatch = debateText.match(/【综合评判】([\s\S]*?)(?=\n【|\n###|\n$|$)/);
      if (debateMatch) debateConclusion = debateMatch[1].trim();

      // 组装历史摘要：综合评判 + 决策结果
      const summaryParts: string[] = [];
      if (debateConclusion) summaryParts.push(`📊 综合评判：${debateConclusion}`);
      if (finalStructured.action) {
        summaryParts.push(
          `⚖️ 最终决策：${finalStructured.action} | 风险${finalStructured.riskLevel} | 信心${finalStructured.confidence}%`
        );
      }
      if (finalStructured.reasoning) summaryParts.push(`📝 ${finalStructured.reasoning}`);

      aiStore.addHistory({
        id: generateId(),
        stockCode: selectedCode,
        stockName: stock.name,
        profileName: currentProfile.name,
        model: currentProfile.model,
        riskLevel: finalStructured.action || '深度分析',
        analysis: summaryParts.join('\n\n') || analystText.slice(0, 500).trim(),
        suggestion: finalStructured.action
          ? `仓位:${finalStructured.position} | 目标:${finalStructured.targetLow}-${finalStructured.targetHigh} | 止损:${finalStructured.stopLoss}`
          : '见详细报告',
        triggeredRulesJson: JSON.stringify([]),
        supportPrice: finalStructured.targetLow,
        resistancePrice: finalStructured.targetHigh,
        createdAt: Date.now(),
      });

      toast.success('深度分析完成');
      setDeepCompleted({});
    } catch (err: any) {
      if (err.name === 'AbortError') {
        // 用户主动取消
      } else {
        const msg = err.message || '深度分析失败';
        setError(msg);
        toast.error(msg);
        // 保留已完成阶段，供"继续生成"断点续传
        setDeepCompleted(completedMap);
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

  return (
    <div>
      {/* 顶部 */}
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
          <Brain className="w-6 h-6 text-purple-500" />
          AI分析
        </h1>
        <button
          onClick={() => setShowSettings(true)}
          className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition"
        >
          <Settings className="w-5 h-5" />
        </button>
      </div>

      {/* API配置信息 */}
      {currentProfile ? (
        <div className="bg-white dark:bg-gray-900 rounded-xl p-3 shadow-sm mb-4 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">{currentProfile.name}</p>
            <p className="text-xs text-gray-500">{currentProfile.model}</p>
          </div>
          <button
            onClick={() => setShowSettings(true)}
            className="text-xs text-blue-600 hover:text-blue-700"
          >
            切换
          </button>
        </div>
      ) : (
        <div className="bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded-xl p-4 mb-4 text-center">
          <p className="text-sm text-blue-700 dark:text-blue-300 mb-2">尚未配置AI模型</p>
          <Button onClick={() => setShowSettings(true)}>添加API配置</Button>
        </div>
      )}

      {/* 股票选择 + 分析按钮 */}
      {currentProfile && (
      <div className="bg-white dark:bg-gray-900 rounded-xl p-4 shadow-sm mb-4">
        <label className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2 block">
          选择股票
        </label>
        <select
          value={selectedCode}
          onChange={(e) => { setSelectedCode(e.target.value); setError(null); setResult(null); }}
          className="w-full p-3 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 mb-3"
        >
          <option value="">-- 请选择自选股 --</option>
          {watchlist.map(stock => (
            <option key={stock.code} value={stock.code}>
              {stock.name} ({stock.code})
            </option>
          ))}
        </select>

        <div className="flex gap-2 mb-1">
          {/* 心姐分析 */}
          <button
            onClick={runAnalysis}
            disabled={!selectedCode || isAnalyzing || isDeepAnalyzing}
            className={cn(
              "flex-1 py-3 rounded-xl font-medium flex items-center justify-center gap-2 transition",
              !selectedCode || isAnalyzing || isDeepAnalyzing
                ? "bg-gray-200 text-gray-400 cursor-not-allowed"
                : "bg-purple-600 text-white hover:bg-purple-700 shadow-lg shadow-purple-200"
            )}
          >
            {isAnalyzing ? (
              <><Loader2 className="w-5 h-5 animate-spin" />心姐分析中...</>
            ) : (
              <><Brain className="w-5 h-5" />心姐分析</>
            )}
          </button>

          {/* 深度分析 */}
          <button
            onClick={() => runDeepAnalysis()}
            disabled={!selectedCode || isAnalyzing || isDeepAnalyzing}
            className={cn(
              "flex-1 py-3 rounded-xl font-medium flex items-center justify-center gap-2 transition",
              !selectedCode || isAnalyzing || isDeepAnalyzing
                ? "bg-gray-200 text-gray-400 cursor-not-allowed"
                : "bg-indigo-600 text-white hover:bg-indigo-700 shadow-lg shadow-indigo-200"
            )}
          >
            {isDeepAnalyzing ? (
              <><Loader2 className="w-5 h-5 animate-spin" />深度分析中...</>
            ) : (
              <><Brain className="w-5 h-5" />深度分析</>
            )}
          </button>
        </div>

        {/* 深度分析提示 */}
        <p className="text-xs text-amber-600 dark:text-amber-400 mb-1">
          ⚠️ 深度分析耗时约1-3分钟，消耗较多Token，请耐心等待
        </p>

        {(isAnalyzing || isDeepAnalyzing) && (
          <button
            onClick={cancelAnalysis}
            className="w-full py-2 text-sm text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950 rounded-lg transition"
          >
            取消分析
          </button>
        )}
      </div>
      )}

      {/* 错误 */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-4 text-red-600 text-sm">
          {error}
          {!isDeepAnalyzing && Object.keys(deepCompleted).length > 0 && (
            <button
              onClick={() => runDeepAnalysis(deepCompleted)}
              className="ml-2 px-3 py-1 bg-red-600 text-white rounded-lg text-xs font-medium hover:bg-red-700 transition"
            >
              继续生成（从断点恢复）
            </button>
          )}
        </div>
      )}

      {/* 分析结果 */}
      {(result || streamingText) && (
        <div className="space-y-4 mb-6">
          {/* 风险等级 */}
          {result?.riskLevel ? (
            <div className={cn(
              "rounded-xl p-5 shadow-sm",
              result.riskLevel.includes('高') ? "bg-red-50 dark:bg-red-950 border border-red-200" :
              result.riskLevel.includes('中') ? "bg-orange-50 dark:bg-orange-950 border border-orange-200" :
              "bg-blue-50 dark:bg-blue-950 border border-blue-200"
            )}>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-500">风险等级</p>
                  <p className="text-2xl font-bold mt-1">{result.riskLevel}</p>
                </div>
                <div className="text-right text-sm">
                  <div className="text-gray-500">支撑 / 压力</div>
                  <div className="font-medium mt-1">
                    <span className="text-green-600">{result.supportPrice}</span>
                    {' / '}
                    <span className="text-red-600">{result.resistancePrice}</span>
                  </div>
                </div>
              </div>
            </div>
          ) : streamingText ? (
            <div className="rounded-xl p-5 shadow-sm bg-gray-50 dark:bg-gray-950 border border-gray-200 animate-pulse">
              <p className="text-sm text-gray-500">正在接收分析结果...</p>
            </div>
          ) : null}

          {/* 触发规则 */}
          {result && result.triggeredRules.length > 0 && (
            <div className="bg-white dark:bg-gray-900 rounded-xl p-4 shadow-sm">
              <h3 className="font-semibold mb-3">AI识别的触发规则</h3>
              <div className="space-y-2">
                {result.triggeredRules.map((rule: any, i: number) => (
                  <div key={i} className={cn(
                    "p-3 rounded-lg text-sm",
                    rule.level === 'CRITICAL' ? "bg-red-50 text-red-700" :
                    rule.level === 'WARNING' ? "bg-orange-50 text-orange-700" :
                    "bg-blue-50 text-blue-700"
                  )}>
                    <span className="font-medium">{rule.rule_name}</span>
                    {rule.detail && rule.detail !== rule.rule_name && <span className="ml-2 opacity-75">— {rule.detail}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 综合分析 */}
          <div className="bg-white dark:bg-gray-900 rounded-xl p-4 shadow-sm">
            <h3 className="font-semibold mb-2">综合分析</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 whitespace-pre-wrap leading-relaxed">
              {result?.analysis || ''}
              {isAnalyzing && <span className="inline-block w-0.5 h-4 bg-purple-500 ml-0.5 animate-pulse align-middle" />}
            </p>
          </div>

          {/* 操作建议 */}
          {(result?.suggestion || isAnalyzing) && (
            <div className="bg-white dark:bg-gray-900 rounded-xl p-4 shadow-sm border-l-4 border-purple-500">
              <h3 className="font-semibold mb-2 text-purple-700 dark:text-purple-300">操作建议</h3>
              <p className="text-sm text-gray-600 dark:text-gray-400 whitespace-pre-wrap leading-relaxed">
                {result?.suggestion || ''}
                {isAnalyzing && !result?.suggestion && <span className="inline-block w-0.5 h-4 bg-purple-500 ml-0.5 animate-pulse align-middle" />}
              </p>
            </div>
          )}
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
            </div>
          )}

          {/* 阶段一：情报分析 */}
          {deepResult?.analyst && (
            <div className="bg-white dark:bg-gray-900 rounded-xl p-4 shadow-sm">
              <h3 className="font-semibold mb-3 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-blue-500" />
                阶段一：情报分析
              </h3>
              <div className="text-sm text-gray-600 dark:text-gray-400 whitespace-pre-wrap leading-relaxed">
                {deepResult.analyst}
                {isDeepAnalyzing && deepStage === 'analyst' && (
                  <span className="text-blue-500 animate-pulse text-lg font-bold">···</span>
                )}
              </div>
            </div>
          )}
          {isDeepAnalyzing && deepStage === 'debate' && !deepResult?.debate && (
            <div className="flex items-center gap-2 text-base text-blue-500 font-medium py-2">
              <Loader2 className="w-5 h-5 animate-spin" />
              等待辩论...
            </div>
          )}

          {/* 阶段二：多空辩论 */}
          {(deepResult?.debate || deepResult?.debateError || (isDeepAnalyzing && (deepStage === 'debate' || deepStage === 'verdict'))) && (
            <div className="bg-white dark:bg-gray-900 rounded-xl p-4 shadow-sm">
              <h3 className="font-semibold mb-3 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-amber-500" />
                阶段二：多空辩论
              </h3>
              {deepResult?.debateError && (
                <div className="text-xs text-amber-600 mb-2 p-2 bg-amber-50 dark:bg-amber-950 rounded">{deepResult.debateError}</div>
              )}
              {deepResult?.debate ? (
                <div className="text-sm text-gray-600 dark:text-gray-400 whitespace-pre-wrap leading-relaxed">
                  {deepResult.debate}
                  {isDeepAnalyzing && deepStage === 'debate' && (
                    <span className="text-amber-500 animate-pulse">...</span>
                  )}
                </div>
              ) : isDeepAnalyzing && (deepStage === 'debate' || deepStage === 'verdict') ? (
                <div className="text-sm text-gray-400 animate-pulse">等待辩论结果...</div>
              ) : null}
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

              {/* 结构化决策卡片 */}
              {deepResult?.structured?.action ? (
                <div className={cn(
                  "rounded-xl p-4 mb-4",
                  deepResult.structured.action === '买入' ? "bg-red-50 dark:bg-red-950 border border-red-200" :
                  deepResult.structured.action === '卖出' ? "bg-green-50 dark:bg-green-950 border border-green-200" :
                  "bg-gray-50 dark:bg-gray-950 border border-gray-200"
                )}>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <span className="text-gray-500 text-xs">操作</span>
                      <p className="text-xl font-bold">{deepResult.structured.action}</p>
                    </div>
                    <div>
                      <span className="text-gray-500 text-xs">风险等级</span>
                      <p className="text-lg font-semibold">{deepResult.structured.riskLevel}</p>
                    </div>
                    <div>
                      <span className="text-gray-500 text-xs">信心指数</span>
                      <p className="text-lg font-semibold">{deepResult.structured.confidence}%</p>
                    </div>
                    <div>
                      <span className="text-gray-500 text-xs">建议仓位</span>
                      <p className="text-lg font-semibold">{deepResult.structured.position}</p>
                    </div>
                    <div>
                      <span className="text-gray-500 text-xs">目标价位</span>
                      <p className="font-medium"><span className="text-green-600">{deepResult.structured.targetLow}</span> - <span className="text-red-600">{deepResult.structured.targetHigh}</span></p>
                    </div>
                    <div>
                      <span className="text-gray-500 text-xs">止损位</span>
                      <p className="text-red-600 font-medium">{deepResult.structured.stopLoss}</p>
                    </div>
                  </div>

                  {/* 信心指数进度条 */}
                  {deepResult.structured.confidenceScore !== undefined && (
                    <div className="mt-3 pt-3 border-t border-gray-200/60 dark:border-gray-700/60">
                      <div className="flex items-center gap-2">
                        <span className="text-gray-500 text-xs w-16 shrink-0">信心指数</span>
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
            </div>
          )}
        </div>
      )}

      {/* 历史记录 */}
      <AnalysisHistory history={history} />

      {/* 空状态 */}
      {!result && !streamingText && !isAnalyzing && !deepResult && !isDeepAnalyzing && !error && (
        <div className="text-center py-16 text-gray-400">
          <Brain className="w-16 h-16 mx-auto mb-4 opacity-20" />
          <p className="text-lg">选择股票开始AI分析</p>
          <p className="text-sm mt-2">支持所有OpenAI兼容API（DeepSeek、GLM、GPT等）</p>
        </div>
      )}

      {/* AI 对话 */}
      {currentProfile && (
        <AiChat
          currentProfile={currentProfile}
          selectedCode={selectedCode}
          watchlist={watchlist}
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
