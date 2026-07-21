import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface RpsItem {
  tsCode: string;
  name: string;
  industry: string | null;
  rps: number | null;
  ret: number | null;
  latestClose: number | null;
  latestChange: number | null;
  latestVol: number | null;
  ma5: number | null;
  ma13: number | null;
  ma55: number | null;
  gcFresh: boolean;
  gcState: boolean;
  ma55Up: boolean;
}

interface ScannerState {
  // 持久化字段（切走再切回保留上次的选择与结果）
  selectedSectors: string[];
  rpsPeriod: number;
  rpsMin: number;
  rpsIndustry: string;
  rpsResults: RpsItem[];
  // 三个过滤器（AND 组合）
  filterRps: boolean;
  goldenCross: boolean;
  gcDays: number;
  ma55Up: boolean;
  filterRoe: boolean;
  minRoe: number;

  setSelectedSectors: (updater: string[] | ((prev: string[]) => string[])) => void;
  setRpsPeriod: (n: number) => void;
  setRpsMin: (n: number) => void;
  setRpsIndustry: (updater: string | ((prev: string) => string)) => void;
  setRpsResults: (updater: RpsItem[] | ((prev: RpsItem[]) => RpsItem[])) => void;
  setFilterRps: (v: boolean) => void;
  setGoldenCross: (v: boolean) => void;
  setGcDays: (n: number) => void;
  setMa55Up: (v: boolean) => void;
  setFilterRoe: (v: boolean) => void;
  setMinRoe: (n: number) => void;
  clearResults: () => void;
}

const resolve = <T,>(updater: T | ((prev: T) => T), prev: T): T =>
  typeof updater === 'function' ? (updater as (prev: T) => T)(prev) : updater;

export const useScannerStore = create<ScannerState>()(
  persist(
    (set) => ({
      selectedSectors: [],
      rpsPeriod: 250,
      rpsMin: 87,
      rpsIndustry: '',
      rpsResults: [],
      filterRps: true,
      goldenCross: false,
      gcDays: 5,
      ma55Up: false,
      filterRoe: false,
      minRoe: 15,

      setSelectedSectors: (updater) => set((s) => ({ selectedSectors: resolve(updater, s.selectedSectors) })),
      setRpsPeriod: (rpsPeriod) => set({ rpsPeriod }),
      setRpsMin: (rpsMin) => set({ rpsMin }),
      setRpsIndustry: (updater) => set((s) => ({ rpsIndustry: resolve(updater, s.rpsIndustry) })),
      setRpsResults: (updater) => set((s) => ({ rpsResults: resolve(updater, s.rpsResults) })),
      setFilterRps: (filterRps) => set({ filterRps }),
      setGoldenCross: (goldenCross) => set({ goldenCross }),
      setGcDays: (gcDays) => set({ gcDays }),
      setMa55Up: (ma55Up) => set({ ma55Up }),
      setFilterRoe: (filterRoe) => set({ filterRoe }),
      setMinRoe: (minRoe) => set({ minRoe }),
      clearResults: () => set({ rpsResults: [] }),
    }),
    {
      name: 'scanner-store',
      version: 2,
      partialize: (s) => ({
        selectedSectors: s.selectedSectors,
        rpsPeriod: s.rpsPeriod,
        rpsMin: s.rpsMin,
        rpsIndustry: s.rpsIndustry,
        rpsResults: s.rpsResults,
        filterRps: s.filterRps,
        goldenCross: s.goldenCross,
        gcDays: s.gcDays,
        ma55Up: s.ma55Up,
        filterRoe: s.filterRoe,
        minRoe: s.minRoe,
      }),
      // v1→v2：丢弃已删除的 rules 模式字段
      migrate: (persisted: unknown) => {
        const p = persisted as Record<string, unknown> | undefined;
        if (!p) return p as any;
        delete (p as any).mode;
        delete (p as any).perSectorCount;
        delete (p as any).scanResults;
        delete (p as any).scanHistory;
        delete (p as any).scanTime;
        return p as any;
      },
    }
  )
);

/**
 * 一次性清理旧的散落 localStorage key（scanner_mode / scanner_period / ...）。
 * 新 store 统一用 `scanner-store` 单 key，旧 key 是历史遗留，清掉避免混淆与配额占用。
 * 用 `scanner-legacy-cleaned` 标记保证只跑一次；删除不存在的 key 是 no-op，安全。
 */
if (typeof window !== 'undefined') {
  try {
    if (!localStorage.getItem('scanner-legacy-cleaned')) {
      const toRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('scanner_')) toRemove.push(k);
      }
      for (const k of toRemove) localStorage.removeItem(k);
      localStorage.setItem('scanner-legacy-cleaned', '1');
    }
  } catch { /* localStorage 不可用时静默 */ }
}
