import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Stock, AlertRecord, AlertRule, WatchlistGroup } from '@/types';
import { generateId } from '@/lib/utils';

/** 默认分组固定 id，不可删除/重命名 */
export const DEFAULT_GROUP_ID = 'default';
export const DEFAULT_GROUP_NAME = '默认分组';

interface StockState {
  // 自选股
  watchlist: Stock[];
  groups: WatchlistGroup[];
  addToWatchlist: (stock: Stock, groupId?: string) => void;
  removeFromWatchlist: (code: string) => void;
  isInWatchlist: (code: string) => boolean;
  updateStockPosition: (code: string, positionPercent: number | undefined) => void;
  moveStockToGroup: (code: string, groupId: string) => void;
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
      groups: [{ id: DEFAULT_GROUP_ID, name: DEFAULT_GROUP_NAME }],
      addToWatchlist: (stock, groupId) => {
        const { watchlist } = get();
        if (!watchlist.some(s => s.code === stock.code)) {
          set({ watchlist: [...watchlist, { ...stock, groupId: groupId ?? DEFAULT_GROUP_ID }] });
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
            s.code === code ? { ...s, groupId } : s
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
        if (!trimmed || trimmed.length > 12 || groupId === DEFAULT_GROUP_ID) return false;
        if (get().groups.some(g => g.id !== groupId && g.name === trimmed)) return false;
        set({ groups: get().groups.map(g => g.id === groupId ? { ...g, name: trimmed } : g) });
        return true;
      },
      deleteGroup: (groupId) => {
        if (groupId === DEFAULT_GROUP_ID) return;
        const { groups, watchlist } = get();
        set({
          groups: groups.filter(g => g.id !== groupId),
          watchlist: watchlist.map(s =>
            s.groupId === groupId ? { ...s, groupId: DEFAULT_GROUP_ID } : s
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
      // 旧数据(version 0)升级：自建组初始化 + 存量自选逐项补默认分组
      version: 1,
      migrate: (persistedState: any) => {
        const state = persistedState ?? {};
        return {
          ...state,
          groups:
            Array.isArray(state.groups) && state.groups.length > 0
              ? state.groups
              : [{ id: DEFAULT_GROUP_ID, name: DEFAULT_GROUP_NAME }],
          watchlist: (state.watchlist ?? []).map((s: Stock) => ({
            ...s,
            groupId: s.groupId ?? DEFAULT_GROUP_ID,
          })),
        };
      },
    }
  )
);
