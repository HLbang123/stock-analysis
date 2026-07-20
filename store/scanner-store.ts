import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ScanMode = 'rules' | 'rps';

export interface ScanResult {
  code: string;
  name: string;
  quote: any;
  alerts: any[];
  alertCount: number;
  isNew?: boolean;
}

export interface RpsItem {
  tsCode: string;
  name: string;
  industry: string;
  rps: number;
  ret: number;
  latestClose: number;
  latestChange: number;
  latestVol: number;
}

interface ScannerState {
  // 持久化字段（切走再切回保留上次的选择与结果）
  mode: ScanMode;
  selectedSectors: string[];
  perSectorCount: number;
  scanResults: ScanResult[];
  scanHistory: ScanResult[];
  scanTime: string;
  rpsPeriod: number;
  rpsMin: number;
  rpsIndustry: string;
  rpsResults: RpsItem[];

  setMode: (mode: ScanMode) => void;
  setSelectedSectors: (updater: string[] | ((prev: string[]) => string[])) => void;
  setPerSectorCount: (n: number) => void;
  setScanResults: (updater: ScanResult[] | ((prev: ScanResult[]) => ScanResult[])) => void;
  setScanHistory: (updater: ScanResult[] | ((prev: ScanResult[]) => ScanResult[])) => void;
  setScanTime: (t: string) => void;
  setRpsPeriod: (n: number) => void;
  setRpsMin: (n: number) => void;
  setRpsIndustry: (updater: string | ((prev: string) => string)) => void;
  setRpsResults: (updater: RpsItem[] | ((prev: RpsItem[]) => RpsItem[])) => void;
  clearScanResults: () => void;
}

const resolve = <T,>(updater: T | ((prev: T) => T), prev: T): T =>
  typeof updater === 'function' ? (updater as (prev: T) => T)(prev) : updater;

export const useScannerStore = create<ScannerState>()(
  persist(
    (set) => ({
      mode: 'rps',
      selectedSectors: [],
      perSectorCount: 3,
      scanResults: [],
      scanHistory: [],
      scanTime: '',
      rpsPeriod: 250,
      rpsMin: 87,
      rpsIndustry: '',
      rpsResults: [],

      setMode: (mode) => set({ mode }),
      setSelectedSectors: (updater) => set((s) => ({ selectedSectors: resolve(updater, s.selectedSectors) })),
      setPerSectorCount: (perSectorCount) => set({ perSectorCount }),
      setScanResults: (updater) => set((s) => ({ scanResults: resolve(updater, s.scanResults) })),
      setScanHistory: (updater) => set((s) => ({ scanHistory: resolve(updater, s.scanHistory) })),
      setScanTime: (scanTime) => set({ scanTime }),
      setRpsPeriod: (rpsPeriod) => set({ rpsPeriod }),
      setRpsMin: (rpsMin) => set({ rpsMin }),
      setRpsIndustry: (updater) => set((s) => ({ rpsIndustry: resolve(updater, s.rpsIndustry) })),
      setRpsResults: (updater) => set((s) => ({ rpsResults: resolve(updater, s.rpsResults) })),
      clearScanResults: () => set({ scanResults: [], scanHistory: [], scanTime: '' }),
    }),
    {
      name: 'scanner-store',
      version: 1,
      partialize: (s) => ({
        mode: s.mode,
        selectedSectors: s.selectedSectors,
        perSectorCount: s.perSectorCount,
        scanResults: s.scanResults,
        scanHistory: s.scanHistory,
        scanTime: s.scanTime,
        rpsPeriod: s.rpsPeriod,
        rpsMin: s.rpsMin,
        rpsIndustry: s.rpsIndustry,
        rpsResults: s.rpsResults,
      }),
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
