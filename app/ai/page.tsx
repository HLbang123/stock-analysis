'use client';

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useStockStore } from '@/store';
import { useAiStore, AiProfile, AiAnalysisRecord } from '@/store/ai-store';
import { getRealtimeQuote, getKLineSina } from '@/services/stockApi';
import { ALERT_RULES, checkAllRules } from '@/services/alertRules';
import { buildSystemPrompt, buildUserPrompt } from '@/services/aiPrompt';
import {
  buildAnalystSystemPrompt, buildAnalystUserPrompt,
  buildDebateRound1SystemPrompt, buildDebateUserPrompt,
  buildVerdictSystemPrompt, buildVerdictUserPrompt,
  buildReflectionContext,
} from '@/services/deepAnalysisPrompt';
import { KLineData, RealtimeQuote } from '@/types';
import { calculateIndicators, formatIndicatorsForPrompt } from '@/lib/indicators';
import { isETF } from '@/lib/identify';
import { getMarketStatus } from '@/lib/identify';
import { formatPrice, formatChange, cn } from '@/lib/utils';
import { Brain, Settings, X, Plus, Pencil, Trash2, Check, Loader2, ChevronDown, ChevronRight, Send, Trash } from 'lucide-react';
import { fetchTushareData, formatTushareForPrompt } from '@/services/tushareData';
import { toast } from 'sonner';

const PRESET_PLATFORMS: { name: string; baseUrl: string; model: string }[] = [
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.1-8b-instant' },
  { name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
];

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

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
  const [expandedHistory, setExpandedHistory] = useState<Set<string>>(new Set());
  const [streamingText, setStreamingText] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  // 深度分析状态
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
  const [showHistory, setShowHistory] = useState(false);

  // 对话状态
  const [chatMessages, setChatMessages] = useState<{ role: 'user' | 'assistant'; content: string }[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [isChatStreaming, setIsChatStreaming] = useState(false);
  const [attachStockContext, setAttachStockContext] = useState(true);
  const [attachAnalysisResult, setAttachAnalysisResult] = useState(true);
  const chatAbortRef = useRef<AbortController | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // 表单状态
  const [formName, setFormName] = useState('');
  const [formApiKey, setFormApiKey] = useState('');
  const [formBaseUrl, setFormBaseUrl] = useState('');
  const [formModel, setFormModel] = useState('');
  const [formModels, setFormModels] = useState<string[]>([]);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  const currentProfile = profiles.find(p => p.id === currentProfileId);

  // 重置表单
  const resetForm = () => {
    setFormName('');
    setFormApiKey('');
    setFormBaseUrl('');
    setFormModel('');
    setFormModels([]);
    setTestResult(null);
  };

  const openAddProfile = () => {
    resetForm();
    setEditingProfile(null);
    setShowAddProfile(true);
  };

  const openEditProfile = (p: AiProfile) => {
    setFormName(p.name);
    setFormApiKey(p.apiKey);
    setFormBaseUrl(p.baseUrl);
    setFormModel(p.model);
    setEditingProfile(p);
    setShowAddProfile(true);
  };

  // 获取模型列表
  const fetchModels = async () => {
    if (!formBaseUrl) return;
    setIsFetchingModels(true);
    try {
      const res = await fetch('/api/ai/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: formBaseUrl, apiKey: formApiKey }),
      });
      const data = await res.json();
      if (data.models) {
        setFormModels(data.models);
      } else {
        toast.error(data.error || '获取失败');
      }
    } catch {
      toast.error('获取模型列表失败');
    } finally {
      setIsFetchingModels(false);
    }
  };

  // 测试连接
  const testConnection = async () => {
    if (!formBaseUrl || !formModel) return;
    setIsTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/ai/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: formBaseUrl, apiKey: formApiKey, model: formModel }),
      });
      const data = await res.json();
      setTestResult(data.success ? `✅ ${data.message}` : `❌ ${data.message}`);
    } catch {
      setTestResult('❌ 连接失败');
    } finally {
      setIsTesting(false);
    }
  };

  // 保存Profile
  const saveProfile = () => {
    if (!formName || !formBaseUrl || !formModel) {
      toast.error('请填写名称、Base URL 和 Model');
      return;
    }
    if (editingProfile) {
      aiStore.updateProfile({
        ...editingProfile,
        name: formName,
        apiKey: formApiKey,
        baseUrl: formBaseUrl,
        model: formModel,
      });
      toast.success('配置已更新');
    } else {
      aiStore.addProfile({
        id: generateId(),
        name: formName,
        apiKey: formApiKey,
        baseUrl: formBaseUrl,
        model: formModel,
      });
      toast.success('配置已添加');
    }
    setShowAddProfile(false);
    resetForm();
  };

  // 选择预设平台
  const selectPreset = (preset: typeof PRESET_PLATFORMS[0]) => {
    setFormBaseUrl(preset.baseUrl);
    setFormModel(preset.model);
    if (!formName) setFormName(preset.name);
  };

  // 从流式文本中逐步解析结构化字段
  const parseStreamContent = useCallback((text: string) => {
    const riskMatch = text.match(/RISK:(.+)/);
    const supportMatch = text.match(/SUPPORT:(.+)/);
    const resistanceMatch = text.match(/RESISTANCE:(.+)/);
    const rulesMatch = text.match(/RULES:(.+)/);

    // 按 --- 分割头部和正文
    const bodySplit = text.split(/^---\s*$/m);
    const body = bodySplit.length > 1 ? bodySplit.slice(1).join('---') : '';

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
    const confMatch = text.match(/CONFIDENCE:(.+)/);
    const confScoreMatch = text.match(/CONFIDENCE_SCORE:\s*([\d.]+)/);
    const targetLowMatch = text.match(/TARGET_LOW:(.+)/);
    const targetHighMatch = text.match(/TARGET_HIGH:(.+)/);
    const stopMatch = text.match(/STOP_LOSS:(.+)/);
    const posMatch = text.match(/POSITION:(.+)/);
    const keyPointsMatch = text.match(/KEY_POINTS:\s*(.+)/);

    const bodySplit = text.split(/^---\s*$/m);
    const body = bodySplit.length > 1 ? bodySplit.slice(1).join('---') : '';

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
      confidenceScore: confScoreMatch ? parseFloat(confScoreMatch[1]) : undefined,
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
      const todayKLine = {
        date: new Date().toISOString().split('T')[0],
        open: quote.open,
        high: quote.high,
        low: quote.low,
        close: quote.price,
        volume: quote.volume,
      };
      const updatedKLines = kLines.length >= 5 ? [...kLines, todayKLine] : kLines;
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

      const systemPrompt = buildSystemPrompt(isETF(selectedCode));
      const marketNote = `[市场状态] ${getMarketStatus().note}\n\n`;
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

  // 深度分析（三阶段）
  const runDeepAnalysis = async () => {
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

    try {
      // 获取数据（K线取60根，比快速分析更多）
      const [quote, kLines, tushareData] = await Promise.all([
        getRealtimeQuote(selectedCode),
        getKLineSina(selectedCode, 240, 120),
        fetchTushareData(selectedCode).catch(() => null),
      ]);

      if (!quote) throw new Error('获取行情失败');

      // 格式化 Tushare 基本面数据
      const tushareBlock = formatTushareForPrompt(tushareData);

      // 运行规则引擎
      const todayKLine = {
        date: new Date().toISOString().split('T')[0],
        open: quote.open,
        high: quote.high,
        low: quote.low,
        close: quote.price,
        volume: quote.volume,
      };
      const updatedKLines = kLines.length >= 5 ? [...kLines, todayKLine] : kLines;
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
      const marketStatusNote = `[市场状态] ${getMarketStatus().note}\n\n`;
      const etf = isETF(selectedCode);
      const stage1 = {
        systemPrompt: buildAnalystSystemPrompt(etf),
        userPrompt: marketStatusNote + buildAnalystUserPrompt(selectedCode, stock.name, quoteJson, klineSummary, engineSummary, indicatorBlock, reflectionBlock, positionNote, etf, tushareBlock),
      };
      // Stage 2 和 Stage 3 的 user prompt 由 route 根据前阶段输出动态构建
      const stage2 = {
        systemPrompt: buildDebateRound1SystemPrompt(),
        userPrompt: marketStatusNote + buildDebateUserPrompt(selectedCode, stock.name, '', quoteJson, indicatorBlock),
      };
      const stage3 = {
        systemPrompt: buildVerdictSystemPrompt(),
        userPrompt: marketStatusNote + buildVerdictUserPrompt(selectedCode, stock.name, '', '', quoteJson, positionNoteVerdict),
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
            }

            if (msg.stage === 'debate') {
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
    } catch (err: any) {
      if (err.name === 'AbortError') {
        // 用户主动取消
      } else {
        const msg = err.message || '深度分析失败';
        setError(msg);
        toast.error(msg);
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

  const cancelChat = () => {
    if (chatAbortRef.current) {
      chatAbortRef.current.abort();
      chatAbortRef.current = null;
    }
    setIsChatStreaming(false);
  };

  const clearChat = () => {
    setChatMessages([]);
  };

  // 自动滚动到底部
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  // 发送对话消息
  const sendMessage = async (text?: string) => {
    const msg = (text || chatInput).trim();
    if (!msg || !currentProfile || isChatStreaming) return;

    setChatInput('');
    const userMsg = { role: 'user' as const, content: msg };
    setChatMessages(prev => [...prev, userMsg]);
    setIsChatStreaming(true);

    const abortController = new AbortController();
    chatAbortRef.current = abortController;

    try {
      // 构建股票上下文（可选）
      let stockContext = '';
      if (attachStockContext && selectedCode) {
        const stock = watchlist.find(s => s.code === selectedCode);
        // 获取最新行情和K线
        const [quote, kLines] = await Promise.all([
          getRealtimeQuote(selectedCode),
          getKLineSina(selectedCode, 240, 60),
        ]);
        if (quote) {
          const klineSummary = kLines.slice(-20).map(k =>
            `${k.date} ${k.open} ${k.high} ${k.low} ${k.close} ${k.volume}`
          ).join('\n');
          stockContext = `当前股票：${stock?.name || quote.name} (${selectedCode})\n实时行情：${JSON.stringify({ price: quote.price, changePercent: quote.changePercent.toFixed(2) + '%', high: quote.high, low: quote.low, open: quote.open, volume: quote.volume })}\n近20日K线：\n${klineSummary}`;

          // 如果有最新分析结果，附上
          if (attachAnalysisResult) {
            if (result) {
              stockContext += `\n\n最新快速分析结论：风险${result.riskLevel}，支撑${result.supportPrice}，压力${result.resistancePrice}\n${result.analysis}`;
            }
            if (deepResult?.structured?.action) {
              const ds = deepResult.structured;
              stockContext += `\n\n最新深度分析结论：${ds.action} | 风险${ds.riskLevel} | 信心${ds.confidence}% | 仓位${ds.position} | 目标${ds.targetLow}-${ds.targetHigh} | 止损${ds.stopLoss}`;
              if (ds.keyPoints && ds.keyPoints.length > 0) {
                stockContext += `\n关键要点：${ds.keyPoints.join('；')}`;
              }
              if (ds.reasoning) {
                stockContext += `\n决策理由：${ds.reasoning.slice(0, 300)}`;
              }
            }
          }
        }
      }

      // 构建 messages（最近10轮）
      const recentMessages = chatMessages.slice(-20).map(m => ({
        role: m.role,
        content: m.content,
      }));
      const allMessages = [...recentMessages, { role: 'user', content: msg }];

      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: allMessages,
          stockContext: stockContext || undefined,
          baseUrl: currentProfile.baseUrl,
          apiKey: currentProfile.apiKey,
          model: currentProfile.model,
        }),
        signal: abortController.signal,
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(errData.error || '请求失败');
      }

      // SSE 流式读取
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = '';
      let aiContent = '';

      // 添加空的 assistant 消息
      setChatMessages(prev => [...prev, { role: 'assistant', content: '' }]);

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
            const chunk = JSON.parse(data);
            if (typeof chunk === 'string') {
              aiContent += chunk;
              // 更新最后一条消息
              setChatMessages(prev => {
                const updated = [...prev];
                updated[updated.length - 1] = { role: 'assistant', content: aiContent };
                return updated;
              });
            }
          } catch {}
        }
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setChatMessages(prev => [...prev, { role: 'assistant', content: `❌ ${err.message}` }]);
      }
    } finally {
      setIsChatStreaming(false);
      chatAbortRef.current = null;
    }
  };

  const handleChatKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
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
          <button
            onClick={() => setShowSettings(true)}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition"
          >
            添加API配置
          </button>
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
          {/* 快速分析 */}
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
            {isAnalyzing && streamingText ? (
              <><Loader2 className="w-5 h-5 animate-spin" />接收中...</>
            ) : isAnalyzing ? (
              <><Loader2 className="w-5 h-5 animate-spin" />连接中...</>
            ) : (
              <><Brain className="w-5 h-5" />快速分析</>
            )}
          </button>

          {/* 深度分析 */}
          <button
            onClick={runDeepAnalysis}
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
                    {rule.detail && <span className="ml-2 opacity-75">— {rule.detail}</span>}
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
                  <span className="inline-block w-0.5 h-4 bg-blue-500 ml-0.5 animate-pulse align-middle" />
                )}
              </div>
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
                    <span className="inline-block w-0.5 h-4 bg-amber-500 ml-0.5 animate-pulse align-middle" />
                  )}
                </div>
              ) : isDeepAnalyzing && (deepStage === 'debate' || deepStage === 'verdict') ? (
                <div className="text-sm text-gray-400 animate-pulse">等待辩论结果...</div>
              ) : null}
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
      {history.length > 0 && (
        <div className="bg-white dark:bg-gray-900 rounded-xl p-4 shadow-sm">
          <button
            onClick={() => setShowHistory(!showHistory)}
            className="flex items-center gap-2 hover:bg-gray-50 dark:hover:bg-gray-800 rounded-lg p-1 -m-1 transition"
          >
            {showHistory ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
            <h3 className="font-semibold">历史分析 ({history.length})</h3>
          </button>
          {showHistory && (
            <>
              <div className="flex justify-end mb-2">
                <button
                  onClick={() => { aiStore.clearHistory(); toast.success('已清空全部历史'); }}
                  className="text-xs text-red-500 hover:text-red-600 px-2 py-1 hover:bg-red-50 dark:hover:bg-red-950 rounded transition"
                >
                  清空全部
                </button>
              </div>
          <div className="space-y-2">
            {history.slice(0, 20).map(record => {
              const isExpanded = expandedHistory.has(record.id);
              return (
                <div key={record.id} className="border border-gray-100 dark:border-gray-800 rounded-lg">
                  <div className="p-3 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-800 rounded-lg transition cursor-pointer"
                    onClick={() => {
                      const next = new Set(expandedHistory);
                      isExpanded ? next.delete(record.id) : next.add(record.id);
                      setExpandedHistory(next);
                    }}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{record.stockName}</p>
                      <p className="text-xs text-gray-500">
                        {record.profileName} · {new Date(record.createdAt).toLocaleString('zh-CN')}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className={cn(
                        "text-xs px-2 py-0.5 rounded-full",
                        record.riskLevel.includes('高') ? "bg-red-100 text-red-600" :
                        record.riskLevel.includes('中') ? "bg-orange-100 text-orange-600" :
                        "bg-blue-100 text-blue-600"
                      )}>
                        {record.riskLevel}
                      </span>
                      <button
                        onClick={(e) => { e.stopPropagation(); aiStore.deleteHistory(record.id); }}
                        className="p-1 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950 rounded transition"
                        title="删除"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                      {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="px-3 pb-3 space-y-2 text-sm text-gray-600 dark:text-gray-400 border-t border-gray-50 dark:border-gray-800 pt-2">
                      <p>{record.analysis}</p>
                      {record.suggestion && (
                        <p className="text-purple-600">💡 {record.suggestion}</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          </>
          )}
        </div>
      )}

      {/* 空状态 */}
      {!result && !streamingText && !isAnalyzing && !deepResult && !isDeepAnalyzing && !error && (
        <div className="text-center py-16 text-gray-400">
          <Brain className="w-16 h-16 mx-auto mb-4 opacity-20" />
          <p className="text-lg">选择股票开始AI分析</p>
          <p className="text-sm mt-2">支持所有OpenAI兼容API（DeepSeek、GLM、GPT等）</p>
        </div>
      )}

      {/* ======= AI 对话 ======= */}
      {currentProfile && (
        <div className="bg-white dark:bg-gray-900 rounded-xl p-4 shadow-sm mb-6">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-sm flex items-center gap-2">
              <Send className="w-4 h-4 text-blue-500" />
              AI 对话
            </h3>
            <div className="flex items-center gap-2">
              {/* 上下文开关 */}
              <label className="flex items-center gap-1.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={attachStockContext}
                  onChange={(e) => setAttachStockContext(e.target.checked)}
                  className="w-3.5 h-3.5 rounded accent-blue-600"
                />
                <span className="text-xs text-gray-500">
                  {selectedCode ? `附上 ${watchlist.find(s => s.code === selectedCode)?.name || selectedCode} 数据` : '附上股票数据'}
                </span>
              </label>
              {/* 附带分析结论开关 */}
              {(result || deepResult?.structured?.action) && (
                <label className="flex items-center gap-1.5 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={attachAnalysisResult}
                    onChange={(e) => setAttachAnalysisResult(e.target.checked)}
                    className="w-3.5 h-3.5 rounded accent-blue-600"
                  />
                  <span className="text-xs text-gray-500">附带分析结论</span>
                </label>
              )}
              {chatMessages.length > 0 && (
                <button
                  onClick={clearChat}
                  className="p-1 text-gray-400 hover:text-red-500 transition"
                  title="清空对话"
                >
                  <Trash className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* 消息列表 */}
          {(chatMessages.length > 0 || isChatStreaming) && (
            <div className="max-h-80 overflow-y-auto space-y-3 mb-3">
            {chatMessages.map((msg, i) => (
              <div
                key={i}
                className={cn(
                  "flex",
                  msg.role === 'user' ? "justify-end" : "justify-start"
                )}
              >
                <div className={cn(
                  "max-w-[85%] rounded-xl px-3.5 py-2.5 text-sm",
                  msg.role === 'user'
                    ? "bg-blue-600 text-white rounded-br-md"
                    : "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-bl-md"
                )}>
                  <div className="whitespace-pre-wrap break-words leading-relaxed">
                    {msg.content}
                    {isChatStreaming && i === chatMessages.length - 1 && msg.role === 'assistant' && (
                      <span className="inline-block w-0.5 h-4 bg-blue-500 ml-0.5 animate-pulse align-middle" />
                    )}
                  </div>
                </div>
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>
          )}

          {/* 输入区 */}
          <div className="flex gap-2">
            <input
              id="chat-input"
              type="text"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={handleChatKeyDown}
              placeholder="输入问题，Enter 发送..."
              disabled={isChatStreaming}
              className="flex-1 px-3.5 py-2.5 border border-gray-200 dark:border-gray-700 rounded-xl bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
            />
            {isChatStreaming ? (
              <button
                onClick={cancelChat}
                className="px-4 py-2.5 bg-red-500 text-white rounded-xl text-sm font-medium hover:bg-red-600 transition"
              >
                停止
              </button>
            ) : (
              <button
                onClick={() => sendMessage()}
                disabled={!chatInput.trim()}
                className="px-4 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-medium hover:bg-blue-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Send className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* ======= 设置弹窗 ======= */}
      {showSettings && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-lg max-h-[85vh] overflow-auto">
            <div className="sticky top-0 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 p-4 flex items-center justify-between">
              <h2 className="font-semibold text-lg">API 配置管理</h2>
              <button onClick={() => setShowSettings(false)} className="p-1">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 space-y-3">
              {profiles.map(p => (
                <div
                  key={p.id}
                  className={cn(
                    "p-3 rounded-xl border transition",
                    p.id === currentProfileId
                      ? "border-blue-500 bg-blue-50 dark:bg-blue-950"
                      : "border-gray-200 dark:border-gray-700"
                  )}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium text-sm">{p.name}</p>
                      <p className="text-xs text-gray-500">{p.model}</p>
                      <p className="text-xs text-gray-400 truncate max-w-[200px]">{p.baseUrl}</p>
                    </div>
                    <div className="flex items-center gap-1">
                      {p.id !== currentProfileId && (
                        <button
                          onClick={() => { aiStore.setCurrentProfile(p.id); setShowSettings(false); }}
                          className="p-1.5 text-blue-600 hover:bg-blue-100 rounded-lg transition text-xs"
                        >
                          使用
                        </button>
                      )}
                      <button
                        onClick={() => openEditProfile(p)}
                        className="p-1.5 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => {
                          aiStore.deleteProfile(p.id);
                          toast.success('已删除');
                        }}
                        className="p-1.5 text-red-500 hover:bg-red-50 rounded-lg transition"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}

              <button
                onClick={openAddProfile}
                className="w-full py-3 border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-xl text-gray-500 hover:border-blue-400 hover:text-blue-500 transition flex items-center justify-center gap-2"
              >
                <Plus className="w-4 h-4" />
                添加API配置
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ======= 添加/编辑Profile弹窗 ======= */}
      {showAddProfile && (
        <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-md max-h-[85vh] overflow-auto">
            <div className="sticky top-0 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 p-4 flex items-center justify-between">
              <h2 className="font-semibold">{editingProfile ? '编辑配置' : '添加API配置'}</h2>
              <button onClick={() => setShowAddProfile(false)} className="p-1">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 space-y-4">
              {/* 预设平台 */}
              <div>
                <label className="text-sm font-medium mb-2 block">快速选择平台</label>
                <div className="flex flex-wrap gap-2">
                  {PRESET_PLATFORMS.map(p => (
                    <button
                      key={p.name}
                      onClick={() => selectPreset(p)}
                      className="px-3 py-1.5 text-xs bg-gray-100 dark:bg-gray-800 rounded-full hover:bg-blue-100 dark:hover:bg-blue-900 transition"
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              </div>

              {/* 名称 */}
              <div>
                <label className="text-sm font-medium mb-1 block">名称</label>
                <input
                  value={formName}
                  onChange={e => setFormName(e.target.value)}
                  placeholder="如: 我的DeepSeek"
                  className="w-full p-2.5 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm"
                />
              </div>

              {/* API Key */}
              <div>
                <label className="text-sm font-medium mb-1 block">API Key</label>
                <input
                  type="password"
                  value={formApiKey}
                  onChange={e => setFormApiKey(e.target.value)}
                  placeholder="sk-..."
                  className="w-full p-2.5 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm"
                />
              </div>

              {/* Base URL */}
              <div>
                <label className="text-sm font-medium mb-1 block">Base URL</label>
                <input
                  value={formBaseUrl}
                  onChange={e => setFormBaseUrl(e.target.value)}
                  placeholder="https://api.deepseek.com/v1"
                  className="w-full p-2.5 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm"
                />
              </div>

              {/* Model */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-sm font-medium">Model</label>
                  <button
                    onClick={fetchModels}
                    disabled={isFetchingModels || !formBaseUrl}
                    className="text-xs text-blue-600 hover:text-blue-700 disabled:opacity-50"
                  >
                    {isFetchingModels ? '获取中...' : '获取模型列表'}
                  </button>
                </div>
                {formModels.length > 0 ? (
                  <select
                    value={formModel}
                    onChange={e => setFormModel(e.target.value)}
                    className="w-full p-2.5 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm"
                  >
                    <option value="">-- 选择模型 --</option>
                    {formModels.map(m => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={formModel}
                    onChange={e => setFormModel(e.target.value)}
                    placeholder="如: deepseek-chat"
                    className="w-full p-2.5 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm"
                  />
                )}
              </div>

              {/* 测试结果 */}
              {testResult && (
                <div className={cn(
                  "p-3 rounded-lg text-sm",
                  testResult.startsWith('✅') ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
                )}>
                  {testResult}
                </div>
              )}

              {/* 操作按钮 */}
              <div className="flex gap-2">
                <button
                  onClick={testConnection}
                  disabled={isTesting || !formBaseUrl || !formModel}
                  className="flex-1 py-2.5 border border-gray-300 dark:border-gray-600 rounded-lg text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-800 transition disabled:opacity-50"
                >
                  {isTesting ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : '测试连接'}
                </button>
                <button
                  onClick={saveProfile}
                  className="flex-1 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition"
                >
                  保存
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
