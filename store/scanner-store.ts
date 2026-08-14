import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** 板块过滤：all=全部 / main=主板 / gem=创业板 / star=科创板 / bjse=北交所 */
export type Board = 'all' | 'main' | 'gem' | 'star' | 'bjse';

/** 阶段预设：none=不限 / startup=启动期 / uptrend=上升期 / pullback=回踩整理（一键套用下方趋势条件组） */
export type ScanPhase = 'none' | 'startup' | 'uptrend' | 'pullback';

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
  // 阶段预设（最近套用的预设，仅作 chip 高亮；条件本体是下方各行，可单独改）
  phase: ScanPhase;
  // 趋势/阶段条件（AND 组合，各自可勾选、数值可调）
  goldenCross: boolean;
  gcDaysList: number[];   // 金叉窗口多选（OR 并集；0=即将金叉，正数=近N日上穿）
  ma55Up: boolean;
  filterMb: boolean;      // 均线多头排列（MA5>MA13>MA55 持续 mbDays 日）
  mbDays: number;
  maRising: boolean;      // 三线上行（MA5/13/55 均 > 5 交易日前）
  nearHigh250: number | null; // 距250日新高 ≤X%（null=不启用）
  filterBias55: boolean;  // 相对 MA55 乖离率 % 区间
  bias55Min: number;
  bias55Max: number;
  filterPbMa13: boolean;  // 相对 MA13 乖离率 % 区间（回踩）
  pbMa13Min: number;
  pbMa13Max: number;
  volShrink: boolean;     // 近5日均量 < 前20日均量
  boxMode: '' | 'in' | 'breakout'; // 吸筹箱体：''=关 / in=箱体内 / breakout=已突破(带量确认)
  // 通用过滤（AND 组合）
  filterRps: boolean;
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
  /** 套用阶段预设：先重置全部阶段条件为预设值（正交条件 RPS/ROE/RSI/市值/板块不动） */
  applyPhase: (p: ScanPhase) => void;
  setGoldenCross: (v: boolean) => void;
  setGcDaysList: (updater: number[] | ((prev: number[]) => number[])) => void;
  setMa55Up: (v: boolean) => void;
  setFilterMb: (v: boolean) => void;
  setMbDays: (n: number) => void;
  setMaRising: (v: boolean) => void;
  setNearHigh250: (v: number | null) => void;
  setFilterBias55: (v: boolean) => void;
  setBias55Min: (n: number) => void;
  setBias55Max: (n: number) => void;
  setFilterPbMa13: (v: boolean) => void;
  setPbMa13Min: (n: number) => void;
  setPbMa13Max: (n: number) => void;
  setVolShrink: (v: boolean) => void;
  setBoxMode: (v: '' | 'in' | 'breakout') => void;
  setFilterRps: (v: boolean) => void;
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
      phase: 'none',
      goldenCross: false,
      gcDaysList: [5],
      ma55Up: false,
      filterMb: false,
      mbDays: 10,
      maRising: false,
      nearHigh250: null,
      filterBias55: false,
      bias55Min: 0,
      bias55Max: 30,
      filterPbMa13: false,
      pbMa13Min: -3,
      pbMa13Max: 5,
      volShrink: false,
      boxMode: '',
      filterRps: true,
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
      applyPhase: (phase) => set({
        phase,
        goldenCross: phase === 'startup',
        gcDaysList: phase === 'startup' ? [0, 5] : [5],
        ma55Up: phase === 'startup',
        filterMb: phase === 'uptrend' || phase === 'pullback',
        mbDays: 10,
        maRising: phase === 'uptrend',
        nearHigh250: phase === 'uptrend' ? 25 : null,
        filterBias55: phase === 'uptrend',
        bias55Min: 0,
        bias55Max: 30,
        filterPbMa13: phase === 'pullback',
        pbMa13Min: -3,
        pbMa13Max: 5,
        volShrink: phase === 'pullback',
      }),
      setGoldenCross: (goldenCross) => set({ goldenCross }),
      setGcDaysList: (updater) => set((s) => ({ gcDaysList: resolve(updater, s.gcDaysList) })),
      setMa55Up: (ma55Up) => set({ ma55Up }),
      setFilterMb: (filterMb) => set({ filterMb }),
      setMbDays: (mbDays) => set({ mbDays }),
      setMaRising: (maRising) => set({ maRising }),
      setNearHigh250: (nearHigh250) => set({ nearHigh250 }),
      setFilterBias55: (filterBias55) => set({ filterBias55 }),
      setBias55Min: (bias55Min) => set({ bias55Min }),
      setBias55Max: (bias55Max) => set({ bias55Max }),
      setFilterPbMa13: (filterPbMa13) => set({ filterPbMa13 }),
      setPbMa13Min: (pbMa13Min) => set({ pbMa13Min }),
      setPbMa13Max: (pbMa13Max) => set({ pbMa13Max }),
      setVolShrink: (volShrink) => set({ volShrink }),
      setBoxMode: (boxMode) => set({ boxMode }),
      setFilterRps: (filterRps) => set({ filterRps }),
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
      version: 10,
      partialize: (s) => ({
        selectedSectors: s.selectedSectors,
        rpsPeriods: s.rpsPeriods,
        rpsMin: s.rpsMin,
        rpsIndustry: s.rpsIndustry,
        industryLevel: s.industryLevel,
        rpsResults: s.rpsResults,
        phase: s.phase,
        goldenCross: s.goldenCross,
        gcDaysList: s.gcDaysList,
        ma55Up: s.ma55Up,
        filterMb: s.filterMb,
        mbDays: s.mbDays,
        maRising: s.maRising,
        nearHigh250: s.nearHigh250,
        filterBias55: s.filterBias55,
        bias55Min: s.bias55Min,
        bias55Max: s.bias55Max,
        filterPbMa13: s.filterPbMa13,
        pbMa13Min: s.pbMa13Min,
        pbMa13Max: s.pbMa13Max,
        volShrink: s.volShrink,
        boxMode: s.boxMode,
        filterRps: s.filterRps,
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
      // v1→v2：丢弃已删除的 rules 模式字段；v2→v3：新增 vcp；v4→v5：新增 board；v5→v6：新增 RSI 过滤字段；v6→v7：新增市值过滤字段（缺省由默认值兜底）；v7→v8：删除 VCP 筛选；v8→v9：rpsPeriod/gcDays 单值改数组多选；v9→v10：新增阶段预设与趋势结构条件（多头排列/三线上行/近新高/乖离/缩量/吸筹箱体，缺省由默认值兜底）
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
