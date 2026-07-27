import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AiPick, AiScreenRun } from '@/services/ai-screen/types';

interface AiScreenState {
  selectedStrategyId: string;
  lastRun: AiScreenRun | null;
  lastPicks: AiPick[];
  setSelectedStrategy: (id: string) => void;
  setLastRun: (run: AiScreenRun | null, picks: AiPick[]) => void;
  clear: () => void;
}

export const useAiScreenStore = create<AiScreenState>()(
  persist(
    (set) => ({
      selectedStrategyId: 'balanced',
      lastRun: null,
      lastPicks: [],
      setSelectedStrategy: (selectedStrategyId) => set({ selectedStrategyId }),
      setLastRun: (lastRun, lastPicks) => set({ lastRun, lastPicks }),
      clear: () => set({ lastRun: null, lastPicks: [] }),
    }),
    {
      name: 'ai-screen-store',
      version: 1,
      partialize: (s) => ({ selectedStrategyId: s.selectedStrategyId, lastRun: s.lastRun, lastPicks: s.lastPicks }),
    },
  ),
);
