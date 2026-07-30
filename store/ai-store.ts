import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface AiProfile {
  id: string;
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;
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

  addProfile: (p: AiProfile) => void;
  updateProfile: (p: AiProfile) => void;
  deleteProfile: (id: string) => void;
  setCurrentProfile: (id: string) => void;
  addHistory: (record: AiAnalysisRecord) => void;
  deleteHistory: (id: string) => void;
  clearHistory: () => void;
}

export const useAiStore = create<AiStoreState>()(
  persist(
    (set, get) => ({
      profiles: [],
      currentProfileId: '',
      history: [],

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
    }),
    {
      name: 'stock-ai-store',
      partialize: (state) => ({
        profiles: state.profiles,
        currentProfileId: state.currentProfileId,
        history: state.history,
      }),
    }
  )
);
