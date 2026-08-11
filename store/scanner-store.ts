import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** 板块过滤：all=全部 / main=主板 / gem=创业板 / star=科创板 / bjse=北交所 */
export type Board = 'all' | 'main' | 'gem' | 'star' | 'bjse';

export interface RpsItem {
  tsCode: string;
  name: string;
  industry: string | null;
  /** 多周期 RPS（每个选中周期一个值）；旧持久化结果可能没有此字段，前端回退显示 rps */
  rpsList?: { period: number; rps: number | null }[];
  rps: number | null; // 主周期（最短选中周期）RPS
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
  roe: number | null;
  rsi: number | null;
}

interface ScannerState {
  // 持久化字段（切走再切回保留上次的选择与结果）
  selectedSectors: string[];
  rpsPeriods: number[];   // RPS 周期多选（AND 共振：每个周期都 ≥ rpsMin）
  rpsMin: number;
  rpsIndustry: string;
  industryLevel: 'L1' | 'L2';
  rpsResults: RpsItem[];
  // 过滤器（AND 组合）
  filterRps: boolean;
  goldenCross: boolean;
  gcDaysList: number[];   // 金叉窗口多选（OR 并集；0=即将金叉，正数=近N日上穿）
  ma55Up: boolean;
  filterRoe: boolean;
  minRoe: number;
  filterRsi: boolean;
  rsiPeriod: number;
  rsiMin: number | null;
  rsiMax: number | null;
  board: Board;
  filterMv: boolean;
  minMv: number; // 流通市值下限（亿元）

  setSelectedSectors: (updater: string[] | ((prev: string[]) => string[])) => void;
  setRpsPeriods: (updater: number[] | ((prev: number[]) => number[])) => void;
  setRpsMin: (n: number) => void;
  setRpsIndustry: (updater: string | ((prev: string) => string)) => void;
  setIndustryLevel: (v: 'L1' | 'L2') => void;
  setRpsResults: (updater: RpsItem[] | ((prev: RpsItem[]) => RpsItem[])) => void;
  setFilterRps: (v: boolean) => void;
  setGoldenCross: (v: boolean) => void;
  setGcDaysList: (updater: number[] | ((prev: number[]) => number[])) => void;
  setMa55Up: (v: boolean) => void;
  setFilterRoe: (v: boolean) => void;
  setMinRoe: (n: number) => void;
  setFilterRsi: (v: boolean) => void;
  setRsiPeriod: (n: number) => void;
  setRsiMin: (v: number | null) => void;
  setRsiMax: (v: number | null) => void;
  setBoard: (v: Board) => void;
  setFilterMv: (v: boolean) => void;
  setMinMv: (n: number) => void;
  clearResults: () => void;
}

const resolve = <T,>(updater: T | ((prev: T) => T), prev: T): T =>
  typeof updater === 'function' ? (updater as (prev: T) => T)(prev) : updater;

export const useScannerStore = create<ScannerState>()(
  persist(
    (set) => ({
      selectedSectors: [],
      rpsPeriods: [250],
      rpsMin: 87,
      rpsIndustry: '',
      industryLevel: 'L1',
      rpsResults: [],
      filterRps: true,
      goldenCross: false,
      gcDaysList: [5],
      ma55Up: false,
      filterRoe: false,
      minRoe: 15,
      filterRsi: false,
      rsiPeriod: 6,
      rsiMin: null,
      rsiMax: 30,
      board: 'all',
      filterMv: false,
      minMv: 100,

      setSelectedSectors: (updater) => set((s) => ({ selectedSectors: resolve(updater, s.selectedSectors) })),
      setRpsPeriods: (updater) => set((s) => ({ rpsPeriods: resolve(updater, s.rpsPeriods) })),
      setRpsMin: (rpsMin) => set({ rpsMin }),
      setRpsIndustry: (updater) => set((s) => ({ rpsIndustry: resolve(updater, s.rpsIndustry) })),
      setIndustryLevel: (industryLevel) => set({ industryLevel }),
      setRpsResults: (updater) => set((s) => ({ rpsResults: resolve(updater, s.rpsResults) })),
      setFilterRps: (filterRps) => set({ filterRps }),
      setGoldenCross: (goldenCross) => set({ goldenCross }),
      setGcDaysList: (updater) => set((s) => ({ gcDaysList: resolve(updater, s.gcDaysList) })),
      setMa55Up: (ma55Up) => set({ ma55Up }),
      setFilterRoe: (filterRoe) => set({ filterRoe }),
      setMinRoe: (minRoe) => set({ minRoe }),
      setFilterRsi: (filterRsi) => set({ filterRsi }),
      setRsiPeriod: (rsiPeriod) => set({ rsiPeriod }),
      setRsiMin: (rsiMin) => set({ rsiMin }),
      setRsiMax: (rsiMax) => set({ rsiMax }),
      setBoard: (board) => set({ board }),
      setFilterMv: (filterMv) => set({ filterMv }),
      setMinMv: (minMv) => set({ minMv }),
      clearResults: () => set({ rpsResults: [] }),
    }),
    {
      name: 'scanner-store',
      version: 9,
      partialize: (s) => ({
        selectedSectors: s.selectedSectors,
        rpsPeriods: s.rpsPeriods,
        rpsMin: s.rpsMin,
        rpsIndustry: s.rpsIndustry,
        industryLevel: s.industryLevel,
        rpsResults: s.rpsResults,
        filterRps: s.filterRps,
        goldenCross: s.goldenCross,
        gcDaysList: s.gcDaysList,
        ma55Up: s.ma55Up,
        filterRoe: s.filterRoe,
        minRoe: s.minRoe,
        filterRsi: s.filterRsi,
        rsiPeriod: s.rsiPeriod,
        rsiMin: s.rsiMin,
        rsiMax: s.rsiMax,
        board: s.board,
        filterMv: s.filterMv,
        minMv: s.minMv,
      }),
      // v1→v2：丢弃已删除的 rules 模式字段；v2→v3：新增 vcp；v4→v5：新增 board；v5→v6：新增 RSI 过滤字段；v6→v7：新增市值过滤字段（缺省由默认值兜底）；v7→v8：删除 VCP 筛选；v8→v9：rpsPeriod/gcDays 单值改数组多选
      migrate: (persisted: unknown) => {
        const p = persisted as Record<string, unknown> | undefined;
        if (!p) return p as any;
        delete (p as any).mode;
        delete (p as any).perSectorCount;
        delete (p as any).scanResults;
        delete (p as any).scanHistory;
        delete (p as any).scanTime;
        delete (p as any).vcp;
        // v8→v9：单值 → 数组
        if (typeof p.rpsPeriod === 'number' && !Array.isArray(p.rpsPeriods)) p.rpsPeriods = [p.rpsPeriod];
        delete (p as any).rpsPeriod;
        if (typeof p.gcDays === 'number' && !Array.isArray(p.gcDaysList)) p.gcDaysList = [p.gcDays];
        delete (p as any).gcDays;
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
