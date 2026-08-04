import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { TScorePanelResult } from '@/components/ai/TScorePanel';
import type { DeepResult } from '@/services/deep-analysis/engine';

export interface AiProfile {
  id: string;
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
}

/** 上次分析会话快照（用于切路由/切模式后恢复，避免结果丢失） */
export interface LastSession {
  selectedCode: string;
  result: TScorePanelResult | null;
  deepResult: DeepResult | null;
  userView: string;
  userViewReason: string;
}

export interface AiAnalysisRecord {
  id: string;
  stockCode: string;
  stockName: string;
  profileName: string;
  model: string;
  riskLevel: string;
  analysis: string;
  suggestion: string;
  triggeredRulesJson: string;
  supportPrice: string;
  resistancePrice: string;
  createdAt: number;
  entryDate?: string; // 深度分析落库用的交易日 YYYYMMDD（关联全局回测表）
  // 波段评分扩展字段（可选；旧记录无这些字段，向后兼容）
  buyScore?: number;
  sellScore?: number | null;
  buyAdjust?: number;
  sellAdjust?: number | null;
  buyReason?: string;
  sellReason?: string | null;
  buyFactorsJson?: string;
  sellFactorsJson?: string | null;
  intradayJson?: string;
  llmAdjusted?: boolean;
}

interface AiStoreState {
  profiles: AiProfile[];
  currentProfileId: string;
  history: AiAnalysisRecord[];
  chatMessages: ChatMessage[];
  compareCodes: string[];
  lastSession: LastSession | null;

  addProfile: (p: AiProfile) => void;
  updateProfile: (p: AiProfile) => void;
  deleteProfile: (id: string) => void;
  setCurrentProfile: (id: string) => void;
  addHistory: (record: AiAnalysisRecord) => void;
  deleteHistory: (id: string) => void;
  clearHistory: () => void;
  setChatMessages: (updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => void;
  setCompareCodes: (updater: string[] | ((prev: string[]) => string[])) => void;
  updateLastSession: (patch: Partial<LastSession>) => void;
  clearChatMessages: () => void;
}

export const useAiStore = create<AiStoreState>()(
  persist(
    (set, get) => ({
      profiles: [],
      currentProfileId: '',
      history: [],
      chatMessages: [],
      compareCodes: [],
      lastSession: null,

      addProfile: (p) => {
        const { profiles } = get();
        const isFirst = profiles.length === 0;
        set({
          profiles: [...profiles, p],
          currentProfileId: isFirst ? p.id : get().currentProfileId,
        });
      },

      updateProfile: (p) => {
        set({
          profiles: get().profiles.map(pr => (pr.id === p.id ? p : pr)),
        });
      },

      deleteProfile: (id) => {
        const { profiles, currentProfileId } = get();
        const newProfiles = profiles.filter(p => p.id !== id);
        set({
          profiles: newProfiles,
          currentProfileId: currentProfileId === id ? (newProfiles[0]?.id || '') : currentProfileId,
        });
      },

      setCurrentProfile: (id) => {
        set({ currentProfileId: id });
      },

      addHistory: (record) => {
        set({ history: [record, ...get().history].slice(0, 100) });
      },

      deleteHistory: (id) => {
        set({ history: get().history.filter(h => h.id !== id) });
      },

      clearHistory: () => {
        set({ history: [] });
      },

      setChatMessages: (updater) => {
        const next = typeof updater === 'function' ? (updater as (p: ChatMessage[]) => ChatMessage[])(get().chatMessages) : updater;
        set({ chatMessages: next });
      },

      setCompareCodes: (updater) => {
        const next = typeof updater === 'function' ? (updater as (p: string[]) => string[])(get().compareCodes) : updater;
        set({ compareCodes: next });
      },

      updateLastSession: (patch) => {
        const prev = get().lastSession;
        set({ lastSession: { ...(prev as LastSession | null), ...patch } as LastSession });
      },

      clearChatMessages: () => {
        set({ chatMessages: [] });
      },
    }),
    {
      name: 'stock-ai-store',
      partialize: (state) => ({
        profiles: state.profiles,
        currentProfileId: state.currentProfileId,
        history: state.history,
        chatMessages: state.chatMessages,
        compareCodes: state.compareCodes,
        lastSession: state.lastSession,
      }),
    }
  )
);
