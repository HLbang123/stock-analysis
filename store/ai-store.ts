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
}

const DEFAULT_PROFILE: AiProfile = {
  id: 'default-pollinations',
  name: 'Pollinations 免费',
  apiKey: 'pollinations-not-needed',
  baseUrl: 'https://text.pollinations.ai/openai',
  model: 'openai-fast',
};

interface AiStoreState {
  profiles: AiProfile[];
  currentProfileId: string;
  history: AiAnalysisRecord[];

  ensureDefaults: () => void;
  addProfile: (p: AiProfile) => void;
  updateProfile: (p: AiProfile) => void;
  deleteProfile: (id: string) => void;
  setCurrentProfile: (id: string) => void;
  getCurrentProfile: () => AiProfile | undefined;
  addHistory: (record: AiAnalysisRecord) => void;
  deleteHistory: (id: string) => void;
}

export const useAiStore = create<AiStoreState>()(
  persist(
    (set, get) => ({
      profiles: [DEFAULT_PROFILE],
      currentProfileId: DEFAULT_PROFILE.id,
      history: [],

      ensureDefaults: () => {
        const { profiles } = get();
        if (profiles.length === 0) {
          set({ profiles: [DEFAULT_PROFILE], currentProfileId: DEFAULT_PROFILE.id });
        }
      },

      addProfile: (p) => {
        set({ profiles: [...get().profiles, p] });
      },

      updateProfile: (p) => {
        set({
          profiles: get().profiles.map(pr => (pr.id === p.id ? p : pr)),
        });
      },

      deleteProfile: (id) => {
        if (id === DEFAULT_PROFILE.id) return;
        const { profiles, currentProfileId } = get();
        set({
          profiles: profiles.filter(p => p.id !== id),
          currentProfileId: currentProfileId === id ? DEFAULT_PROFILE.id : currentProfileId,
        });
      },

      setCurrentProfile: (id) => {
        set({ currentProfileId: id });
      },

      getCurrentProfile: () => {
        const { profiles, currentProfileId } = get();
        return profiles.find(p => p.id === currentProfileId);
      },

      addHistory: (record) => {
        set({ history: [record, ...get().history].slice(0, 100) });
      },

      deleteHistory: (id) => {
        set({ history: get().history.filter(h => h.id !== id) });
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
