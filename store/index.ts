import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Stock, AlertRecord, AlertRule, WatchlistGroup } from '@/types';
import { generateId } from '@/lib/utils';

/**
 * 自选不分组时 groupId 为 undefined（未分组，只在「全部」下展示）。
 * 2026-08-04 起取消默认分组：迁移逻辑把历史 'default' 组/归属清成未分组。
 */

interface StockState {
  // 自选股
  watchlist: Stock[];
  groups: WatchlistGroup[];
  addToWatchlist: (stock: Stock, groupId?: string) => void;
  removeFromWatchlist: (code: string) => void;
  isInWatchlist: (code: string) => boolean;
  updateStockPosition: (code: string, positionPercent: number | undefined) => void;
  moveStockToGroup: (code: string, groupId: string | undefined) => void;
  addGroup: (name: string) => boolean;
  renameGroup: (groupId: string, name: string) => boolean;
  deleteGroup: (groupId: string) => void;

  // 预警记录
  alerts: AlertRecord[];
  addAlerts: (alerts: AlertRecord[]) => void;
  markAsRead: (id: string) => void;
  clearAlerts: (stockCode?: string) => void;
  clearAllAlerts: () => void;

  // 规则配置
  rules: AlertRule[];
  toggleRule: (ruleId: string) => void;
  updateRuleThreshold: (ruleId: string, threshold: number) => void;

  // 加载状态
  isCheckingAlerts: boolean;
  setIsCheckingAlerts: (checking: boolean) => void;
}

export const useStockStore = create<StockState>()(
  persist(
    (set, get) => ({
      // 自选股
      watchlist: [],
      groups: [],
      addToWatchlist: (stock, groupId) => {
        const { watchlist } = get();
        if (!watchlist.some(s => s.code === stock.code)) {
          set({ watchlist: [...watchlist, { ...stock, groupId }] });
        }
      },
      removeFromWatchlist: (code) => {
        const { watchlist, alerts } = get();
        set({
          watchlist: watchlist.filter(s => s.code !== code),
          alerts: alerts.filter(a => a.stockCode !== code),
        });
      },
      isInWatchlist: (code) => {
        return get().watchlist.some(s => s.code === code);
      },
      updateStockPosition: (code, positionPercent) => {
        set({
          watchlist: get().watchlist.map(s =>
            s.code === code ? { ...s, positionPercent } : s
          ),
        });
      },
      moveStockToGroup: (code, groupId) => {
        set({
          watchlist: get().watchlist.map(s =>
            s.code === code ? { ...s, groupId: groupId || undefined } : s
          ),
        });
      },
      addGroup: (name) => {
        const trimmed = name.trim();
        if (!trimmed || trimmed.length > 12) return false;
        if (get().groups.some(g => g.name === trimmed)) return false;
        set({ groups: [...get().groups, { id: generateId(), name: trimmed }] });
        return true;
      },
      renameGroup: (groupId, name) => {
        const trimmed = name.trim();
        if (!trimmed || trimmed.length > 12) return false;
        if (get().groups.some(g => g.id !== groupId && g.name === trimmed)) return false;
        set({ groups: get().groups.map(g => g.id === groupId ? { ...g, name: trimmed } : g) });
        return true;
      },
      deleteGroup: (groupId) => {
        const { groups, watchlist } = get();
        set({
          groups: groups.filter(g => g.id !== groupId),
          // 组内自选变未分组（仍可在「全部」看到）
          watchlist: watchlist.map(s =>
            s.groupId === groupId ? { ...s, groupId: undefined } : s
          ),
        });
      },

      // 预警记录
      alerts: [],
      addAlerts: (newAlerts) => {
        const { alerts } = get();
        const existingKeys = new Set(alerts.map(a => `${a.stockCode}-${a.ruleId}`));
        const filtered = newAlerts.filter(
          a => !existingKeys.has(`${a.stockCode}-${a.ruleId}`)
        );
        if (filtered.length > 0) {
          set({ alerts: [...filtered, ...alerts].slice(0, 500) }); // keep max 500
        }
      },
      markAsRead: (id) => {
        const { alerts } = get();
        set({
          alerts: alerts.map(a => (a.id === id ? { ...a, isRead: true } : a)),
        });
      },
      clearAlerts: (stockCode) => {
        const { alerts } = get();
        if (stockCode) {
          set({ alerts: alerts.filter(a => a.stockCode !== stockCode) });
        } else {
          set({ alerts: alerts.filter(a => a.isRead) });
        }
      },
      clearAllAlerts: () => set({ alerts: [] }),

      // 规则配置
      rules: [],
      toggleRule: (ruleId) => {
        const { rules } = get();
        set({
          rules: rules.map(r =>
            r.id === ruleId ? { ...r, isEnabled: !r.isEnabled } : r
          ),
        });
      },
      updateRuleThreshold: (ruleId, threshold) => {
        const { rules } = get();
        set({
          rules: rules.map(r =>
            r.id === ruleId ? { ...r, thresholdValue: threshold } : r
          ),
        });
      },

      // 加载状态
      isCheckingAlerts: false,
      setIsCheckingAlerts: (checking) => set({ isCheckingAlerts: checking }),
    }),
    {
      name: 'stock-alert-store',
      partialize: (state) => ({
        watchlist: state.watchlist,
        alerts: state.alerts,
        rules: state.rules,
        groups: state.groups,
      }),
      // 旧数据升级：v2 移除默认分组——历史 'default' 组删除，其成员归位未分组；
      // v0 无分组概念，groups 置空、groupId 保持 undefined 即可
      version: 2,
      migrate: (persistedState: any) => {
        const state = persistedState ?? {};
        return {
          ...state,
          groups: (Array.isArray(state.groups) ? state.groups : []).filter(
            (g: WatchlistGroup) => g.id !== 'default'
          ),
          watchlist: (state.watchlist ?? []).map((s: Stock) =>
            s.groupId === 'default' ? { ...s, groupId: undefined } : s
          ),
        };
      },
    }
  )
);
