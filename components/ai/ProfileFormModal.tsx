'use client';

import { useState } from 'react';
import { useAiStore, AiProfile } from '@/store/ai-store';
import { cn } from '@/lib/utils';
import { X, Loader2, Eye, EyeOff } from 'lucide-react';
import { toast } from 'sonner';
import { PRESET_PLATFORMS, generateId } from './shared';
import { normalizeBaseUrl, buildLLMHeaders } from '@/lib/llm/shared';
import { isDirectConnectionError } from '@/services/llm/browser-client';
import { formatAiError } from '@/lib/ai-error';

interface Props {
  editingProfile: AiProfile | null;
  onClose: () => void;
}

export function ProfileFormModal({ editingProfile, onClose }: Props) {
  const aiStore = useAiStore();
  const [formName, setFormName] = useState(editingProfile?.name ?? '');
  const [formApiKey, setFormApiKey] = useState(editingProfile?.apiKey ?? '');
  const [showApiKey, setShowApiKey] = useState(false);
  const [formBaseUrl, setFormBaseUrl] = useState(editingProfile?.baseUrl ?? '');
  const [formModel, setFormModel] = useState(editingProfile?.model ?? '');
  const [formModels, setFormModels] = useState<string[]>([]);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  const fetchModels = async () => {
    if (!formBaseUrl) return;
    setIsFetchingModels(true);
    try {
      let models: string[] | null = null;
      try {
        // 浏览器直连 provider（不再绕服务器中转）
        const res = await fetch(`${normalizeBaseUrl(formBaseUrl)}/models`, {
          headers: buildLLMHeaders(formApiKey),
        });
        if (!res.ok) {
          throw new Error(formatAiError(res.status, await res.text().catch(() => '')));
        }
        const data = await res.json();
        models = (data.data || []).map((m: any) => m.id).filter(Boolean).sort();
      } catch (directErr: any) {
        // 连接层失败（CORS/TypeError）→ 降级服务器中转
        if (!isDirectConnectionError(directErr)) throw directErr;
        const res = await fetch('/api/ai/models', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ baseUrl: formBaseUrl, apiKey: formApiKey }),
        });
        const data = await res.json();
        if (data.models) {
          models = data.models;
        } else {
          throw new Error(data.error || '获取失败');
        }
      }
      if (models) setFormModels(models);
    } catch (e: any) {
      toast.error(e?.message || '获取模型列表失败');
    } finally {
      setIsFetchingModels(false);
    }
  };

  const testConnection = async () => {
    if (!formBaseUrl || !formModel) return;
    setIsTesting(true);
    setTestResult(null);
    try {
      try {
        // 浏览器直连 provider（不再绕服务器中转）
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 30000);
        const start = Date.now();
        let latency = 0;
        try {
          const res = await fetch(`${normalizeBaseUrl(formBaseUrl)}/chat/completions`, {
            method: 'POST',
            headers: buildLLMHeaders(formApiKey),
            body: JSON.stringify({ model: formModel, messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 }),
            signal: ctrl.signal,
          });
          latency = Date.now() - start;
          if (!res.ok) {
            const text = await res.text().catch(() => '');
            setTestResult(`❌ ${formatAiError(res.status, text)}`);
          } else {
            setTestResult(`✅ 连接成功 (${latency}ms)`);
          }
        } finally {
          clearTimeout(timer);
        }
      } catch (directErr: any) {
        // 连接层失败（CORS/TypeError/超时）→ 降级服务器中转
        if (!isDirectConnectionError(directErr)) throw directErr;
        const res = await fetch('/api/ai/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ baseUrl: formBaseUrl, apiKey: formApiKey, model: formModel }),
        });
        const data = await res.json();
        setTestResult(data.success ? `✅ ${data.message}` : `❌ ${data.message}`);
      }
    } catch {
      setTestResult('❌ 连接失败');
    } finally {
      setIsTesting(false);
    }
  };

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
    onClose();
  };

  const selectPreset = (preset: typeof PRESET_PLATFORMS[0]) => {
    setFormBaseUrl(preset.baseUrl);
    setFormModel(preset.model);
    if (!formName) setFormName(preset.name);
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4">
      <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-md max-h-[85vh] overflow-auto">
        <div className="sticky top-0 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 p-4 flex items-center justify-between">
          <h2 className="font-semibold">{editingProfile ? '编辑配置' : '添加API配置'}</h2>
          <button onClick={onClose} className="p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-4">
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

          <div>
            <label className="text-sm font-medium mb-1 block">名称</label>
            <input
              value={formName}
              onChange={e => setFormName(e.target.value)}
              placeholder="如: 我的DeepSeek"
              className="w-full p-2.5 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm"
            />
          </div>

          <div>
            <label className="text-sm font-medium mb-1 block">API Key</label>
            <div className="relative">
              <input
                type={showApiKey ? 'text' : 'password'}
                value={formApiKey}
                onChange={e => setFormApiKey(e.target.value)}
                placeholder="sk-..."
                className="w-full p-2.5 pr-10 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm"
              />
              <button
                type="button"
                onClick={() => setShowApiKey(v => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition"
                title={showApiKey ? '隐藏' : '显示'}
                aria-label={showApiKey ? '隐藏 API Key' : '显示 API Key'}
              >
                {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div>
            <label className="text-sm font-medium mb-1 block">Base URL</label>
            <input
              value={formBaseUrl}
              onChange={e => setFormBaseUrl(e.target.value)}
              placeholder="https://api.deepseek.com/v1"
              className="w-full p-2.5 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm"
            />
          </div>

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

          {testResult && (
            <div className={cn(
              "p-3 rounded-lg text-sm",
              testResult.startsWith('✅') ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
            )}>
              {testResult}
            </div>
          )}

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
  );
}
