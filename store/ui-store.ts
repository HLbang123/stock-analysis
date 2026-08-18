import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * 页面位置状态 — 钻取详情页返回后，来源页停在原处（tab/分组筛选/策略选择等）。
 * 背景：Next App Router 页面级缓存 staleTime=0，router.back() 回来页面会重挂载，
 * useState 全部重置；模块级 zustand + persist 才能跨重挂载（及跨会话）保住位置。
 * 只放「位置类」状态，瞬态（输入框/加载中/展开收起）不进这里。
 */
interface UiStoreState {
  /** 首页预警分组筛选（'all'=全部） */
  homeAlertGroupId: string;
  /** 自选页分组筛选（'all'=全部） */
  watchlistGroupId: string;
  /** 扫描页顶部 tab */
  scannerTab: 'ai' | 'manual';
  /** AI 筛选 tab 当前策略 */
  aiScreenStrategy: string;
  /** AI 页主视图切换（分析 / AI 对话，页面级互斥） */
  aiMainTab: 'analysis' | 'chat';
  /** 大盘页指数估值选中的指数 */
  marketIdxCode: string;

  setHomeAlertGroupId: (v: string) => void;
  setWatchlistGroupId: (v: string) => void;
  setScannerTab: (v: 'ai' | 'manual') => void;
  setAiScreenStrategy: (v: string) => void;
  setAiMainTab: (v: 'analysis' | 'chat') => void;
  setMarketIdxCode: (v: string) => void;
}

export const useUiStore = create<UiStoreState>()(
  persist(
    (set) => ({
      homeAlertGroupId: 'all',
      watchlistGroupId: 'all',
      scannerTab: 'ai',
      aiScreenStrategy: 'momentum',
      aiMainTab: 'analysis',
      marketIdxCode: '000001.SH',

      setHomeAlertGroupId: (homeAlertGroupId) => set({ homeAlertGroupId }),
      setWatchlistGroupId: (watchlistGroupId) => set({ watchlistGroupId }),
      setScannerTab: (scannerTab) => set({ scannerTab }),
      setAiScreenStrategy: (aiScreenStrategy) => set({ aiScreenStrategy }),
      setAiMainTab: (aiMainTab) => set({ aiMainTab }),
      setMarketIdxCode: (marketIdxCode) => set({ marketIdxCode }),
    }),
    { name: 'ui-store' }
  )
);
