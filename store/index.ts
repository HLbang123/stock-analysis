import { create } from 'zustand';
import { Stock, AlertRecord, AlertRule } from '@/types';

interface StockState {
  // 自选股
  watchlist: Stock[];
  addToWatchlist: (stock: Stock) => void;
  removeFromWatchlist: (code: string) => void;
  isInWatchlist: (code: string) => boolean;

  // 预警记录
  alerts: AlertRecord[];
  addAlerts: (alerts: AlertRecord[]) => void;
  markAsRead: (id: string) => void;
  clearAlerts: (stockCode?: string) => void;
  clearAllAlerts: () => void;
  unreadCount: number;

  // 规则配置
  rules: AlertRule[];
  toggleRule: (ruleId: string) => void;
  updateRuleThreshold: (ruleId: string, threshold: number) => void;

  // 加载状态
  isCheckingAlerts: boolean;
  setIsCheckingAlerts: (checking: boolean) => void;
}

export const useStockStore = create<StockState>((set, get) => ({
      // 自选股
      watchlist: [],
      addToWatchlist: (stock) => {
        const { watchlist } = get();
        if (!watchlist.some(s => s.code === stock.code)) {
          set({ watchlist: [...watchlist, stock] });
        }
      },
      removeFromWatchlist: (code) => {
        const { watchlist, alerts } = get();
        set({
          watchlist: watchlist.filter(s => s.code !== code),
          alerts: alerts.filter(a => a.stockCode !== code)
        });
      },
      isInWatchlist: (code) => {
        return get().watchlist.some(s => s.code === code);
      },

      // 预警记录
      alerts: [],
      addAlerts: (newAlerts) => {
        const { alerts } = get();
        // 去重
        const existingKeys = new Set(alerts.map(a => `${a.stockCode}-${a.ruleId}`));
        const filtered = newAlerts.filter(a => !existingKeys.has(`${a.stockCode}-${a.ruleId}`));
        if (filtered.length > 0) {
          set({ alerts: [...filtered, ...alerts] });
        }
      },
      markAsRead: (id) => {
        const { alerts } = get();
        set({
          alerts: alerts.map(a => a.id === id ? { ...a, isRead: true } : a)
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
      get unreadCount() {
        return get().alerts.filter(a => !a.isRead).length;
      },

      // 规则配置
      rules: [], // 初始化时从 ALERT_RULES 加载
      toggleRule: (ruleId) => {
        const { rules } = get();
        set({
          rules: rules.map(r => r.id === ruleId ? { ...r, isEnabled: !r.isEnabled } : r)
        });
      },
      updateRuleThreshold: (ruleId, threshold) => {
        const { rules } = get();
        set({
          rules: rules.map(r => r.id === ruleId ? { ...r, thresholdValue: threshold } : r)
        });
      },

      // 加载状态
      isCheckingAlerts: false,
      setIsCheckingAlerts: (checking) => set({ isCheckingAlerts: checking })
    })
  );