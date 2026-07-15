'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useStockStore } from '@/store';
import { useAiStore, AiProfile, AiAnalysisRecord } from '@/store/ai-store';
import { getRealtimeQuote, getKLineSina } from '@/services/stockApi';
import { ALERT_RULES, checkAllRules } from '@/services/alertRules';
import { buildSystemPrompt, buildUserPrompt } from '@/services/aiPrompt';
import { KLineData, RealtimeQuote } from '@/types';
import { formatPrice, formatChange, cn } from '@/lib/utils';
import { Brain, Settings, X, Plus, Pencil, Trash2, Check, Loader2, ChevronDown, ChevronRight } from 'lucide-react';
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

  // 确保有默认配置
  useEffect(() => {
    aiStore.ensureDefaults();
  }, []);

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
      const systemPrompt = buildSystemPrompt();
      const userPrompt = buildUserPrompt(selectedCode, stock.name, quoteJson, klineSummary, engineSummary);

      // 调用AI代理
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
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(errData.error || 'API请求失败');
      }

      const data = await res.json();
      const message = data.choices?.[0]?.message;

      // 处理响应（content 或 reasoning_content）
      let content = message?.content || '';
      if (!content && message?.reasoning_content) {
        content = message.reasoning_content;
      }

      // 提取JSON
      let jsonStr = content;
      const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) jsonStr = codeBlockMatch[1].trim();
      else {
        const braceStart = content.indexOf('{');
        const braceEnd = content.lastIndexOf('}');
        if (braceStart >= 0 && braceEnd > braceStart) {
          jsonStr = content.slice(braceStart, braceEnd + 1);
        }
      }

      let parsedResult: any;
      try {
        parsedResult = JSON.parse(jsonStr);
      } catch {
        // JSON解析失败，显示原始文本
        parsedResult = {
          risk_level: '解析失败',
          analysis: content.replace(/```json|```/g, '').trim() || '(AI返回为空)',
          suggestion: 'AI未按JSON格式返回，可尝试切换模型',
          triggered_rules: [],
          key_prices: { support: '--', resistance: '--' },
        };
      }

      const analysisResult = {
        riskLevel: parsedResult.risk_level || '未知',
        analysis: parsedResult.analysis || '分析失败',
        suggestion: parsedResult.suggestion || '',
        triggeredRules: parsedResult.triggered_rules || [],
        supportPrice: parsedResult.key_prices?.support || '--',
        resistancePrice: parsedResult.key_prices?.resistance || '--',
      };

      setResult(analysisResult);

      // 保存历史
      aiStore.addHistory({
        id: generateId(),
        stockCode: selectedCode,
        stockName: stock.name,
        profileName: currentProfile.name,
        model: currentProfile.model,
        riskLevel: analysisResult.riskLevel,
        analysis: analysisResult.analysis,
        suggestion: analysisResult.suggestion,
        triggeredRulesJson: JSON.stringify(analysisResult.triggeredRules),
        supportPrice: analysisResult.supportPrice,
        resistancePrice: analysisResult.resistancePrice,
        createdAt: Date.now(),
      });

      toast.success('AI分析完成');
    } catch (err: any) {
      const msg = err.message || '分析失败';
      setError(msg);
      toast.error(msg);
    } finally {
      setIsAnalyzing(false);
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
      {currentProfile && (
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
      )}

      {/* 免费API提醒 */}
      {currentProfile?.id === 'default-pollinations' && (
        <div className="bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-xl p-3 mb-4 text-sm text-amber-700 dark:text-amber-300">
          ⚠️ 当前使用免费API（Pollinations.ai），可能不稳定或响应较慢。建议添加自己的API Key获得更好体验。
        </div>
      )}

      {/* 股票选择 + 分析按钮 */}
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

        <button
          onClick={runAnalysis}
          disabled={!selectedCode || isAnalyzing}
          className={cn(
            "w-full py-3 rounded-xl font-medium flex items-center justify-center gap-2 transition",
            !selectedCode || isAnalyzing
              ? "bg-gray-200 text-gray-400 cursor-not-allowed"
              : "bg-purple-600 text-white hover:bg-purple-700 shadow-lg shadow-purple-200"
          )}
        >
          {isAnalyzing ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              正在分析中（预计10-60秒）...
            </>
          ) : (
            <>
              <Brain className="w-5 h-5" />
              开始AI分析
            </>
          )}
        </button>
      </div>

      {/* 错误 */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-4 text-red-600 text-sm">
          {error}
        </div>
      )}

      {/* 分析结果 */}
      {result && (
        <div className="space-y-4 mb-6">
          {/* 风险等级 */}
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

          {/* 触发规则 */}
          {result.triggeredRules.length > 0 && (
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
              {result.analysis}
            </p>
          </div>

          {/* 操作建议 */}
          {result.suggestion && (
            <div className="bg-white dark:bg-gray-900 rounded-xl p-4 shadow-sm border-l-4 border-purple-500">
              <h3 className="font-semibold mb-2 text-purple-700 dark:text-purple-300">操作建议</h3>
              <p className="text-sm text-gray-600 dark:text-gray-400 whitespace-pre-wrap leading-relaxed">
                {result.suggestion}
              </p>
            </div>
          )}
        </div>
      )}

      {/* 历史记录 */}
      {history.length > 0 && (
        <div className="bg-white dark:bg-gray-900 rounded-xl p-4 shadow-sm">
          <h3 className="font-semibold mb-3">历史分析 ({history.length})</h3>
          <div className="space-y-2">
            {history.slice(0, 20).map(record => {
              const isExpanded = expandedHistory.has(record.id);
              return (
                <div key={record.id} className="border border-gray-100 dark:border-gray-800 rounded-lg">
                  <button
                    onClick={() => {
                      const next = new Set(expandedHistory);
                      isExpanded ? next.delete(record.id) : next.add(record.id);
                      setExpandedHistory(next);
                    }}
                    className="w-full p-3 flex items-center justify-between text-left hover:bg-gray-50 dark:hover:bg-gray-800 rounded-lg transition"
                  >
                    <div>
                      <p className="text-sm font-medium">{record.stockName}</p>
                      <p className="text-xs text-gray-500">
                        {record.profileName} · {new Date(record.createdAt).toLocaleString('zh-CN')}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={cn(
                        "text-xs px-2 py-0.5 rounded-full",
                        record.riskLevel.includes('高') ? "bg-red-100 text-red-600" :
                        record.riskLevel.includes('中') ? "bg-orange-100 text-orange-600" :
                        "bg-blue-100 text-blue-600"
                      )}>
                        {record.riskLevel}
                      </span>
                      {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    </div>
                  </button>
                  {isExpanded && (
                    <div className="px-3 pb-3 space-y-2 text-sm text-gray-600 dark:text-gray-400">
                      <p>{record.analysis}</p>
                      {record.suggestion && (
                        <p className="text-purple-600">💡 {record.suggestion}</p>
                      )}
                      <button
                        onClick={() => aiStore.deleteHistory(record.id)}
                        className="text-xs text-red-500 hover:text-red-600"
                      >
                        删除记录
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 空状态 */}
      {!result && !isAnalyzing && !error && (
        <div className="text-center py-16 text-gray-400">
          <Brain className="w-16 h-16 mx-auto mb-4 opacity-20" />
          <p className="text-lg">选择股票开始AI分析</p>
          <p className="text-sm mt-2">支持所有OpenAI兼容API（DeepSeek、GLM、GPT等）</p>
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
                      {p.id !== 'default-pollinations' && (
                        <button
                          onClick={() => {
                            aiStore.deleteProfile(p.id);
                            toast.success('已删除');
                          }}
                          className="p-1.5 text-red-500 hover:bg-red-50 rounded-lg transition"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
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
