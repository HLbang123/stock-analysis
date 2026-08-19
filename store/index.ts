import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Stock, AlertRecord, AlertRule, WatchlistGroup } from '@/types';
import { generateId } from '@/lib/utils';

/**
 * 自选（v3 起为多组映射结构）：
 * - watchlist 平铺全部标的（无组概念，未分组即「全部」下可见）
 * - groups 持有 stockCodes：分组只是「全部」里的子集映射，一个标的可同时在多个组
 * 2026-08-04 取消默认分组；2026-08-13 v3 改为多组（group.stockCodes），迁移收集旧 groupId。
 */

interface StockState {
  // 自选股
  watchlist: Stock[];
  groups: WatchlistGroup[];
  /** 添加标的；已存在时若给了 groupId 则补入该组（多组语义），不重复添加 */
  addToWatchlist: (stock: Stock, groupId?: string) => void;
  removeFromWatchlist: (code: string) => void;
  /** 批量删除（多选删除用）：从自选+所有分组+预警一并清除 */
  removeStocks: (codes: string[]) => void;
  isInWatchlist: (code: string) => boolean;
  updateStockPosition: (code: string, positionPercent: number | undefined) => void;
  /** 勾选/取消分组归属（多组复制语义） */
  toggleStockGroup: (code: string, groupId: string) => void;
  /** 批量移动：codes 加入 targetId 组（null=只移出），并从 fromId 组移出（多选移动分组用） */
  moveStocksToGroup: (codes: string[], targetId: string | null, fromId?: string) => void;
  /** 拖动排序：orderedCodes 为完整新顺序。groupId 缺省=排「全部」(watchlist 数组)；给了=排该组 stockCodes */
  reorderStocks: (orderedCodes: string[], groupId?: string) => void;
  /** 拖动排序分组：orderedIds 为完整新顺序（分组 tab 展示顺序） */
  reorderGroups: (orderedIds: string[]) => void;
  addGroup: (name: string) => boolean;
  renameGroup: (groupId: string, name: string) => boolean;
  /** 删除分组；withStocks=true 时同时删除该组独有标的（其他组也有的保留） */
  deleteGroup: (groupId: string, withStocks?: boolean) => void;

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
        const { watchlist, groups } = get();
        if (watchlist.some(s => s.code === stock.code)) {
          // 已存在：补入指定分组（多组语义），不重复添加
          if (groupId && !groups.some(g => g.id === groupId && g.stockCodes.includes(stock.code))) {
            set({
              groups: groups.map(g =>
                g.id === groupId ? { ...g, stockCodes: [...g.stockCodes, stock.code] } : g
              ),
            });
          }
          return;
        }
        const nextGroups = groupId
          ? groups.map(g => g.id === groupId ? { ...g, stockCodes: [...g.stockCodes, stock.code] } : g)
          : groups;
        set({ watchlist: [...watchlist, { ...stock }], groups: nextGroups });
      },
      removeFromWatchlist: (code) => {
        const { watchlist, groups, alerts } = get();
        set({
          watchlist: watchlist.filter(s => s.code !== code),
          groups: groups.map(g => ({ ...g, stockCodes: g.stockCodes.filter(c => c !== code) })),
          alerts: alerts.filter(a => a.stockCode !== code),
        });
      },
      removeStocks: (codes) => {
        const { watchlist, groups, alerts } = get();
        const del = new Set(codes);
        set({
          watchlist: watchlist.filter(s => !del.has(s.code)),
          groups: groups.map(g => ({ ...g, stockCodes: g.stockCodes.filter(c => !del.has(c)) })),
          alerts: alerts.filter(a => !del.has(a.stockCode)),
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
      toggleStockGroup: (code, groupId) => {
        set({
          groups: get().groups.map(g => {
            if (g.id !== groupId) return g;
            return g.stockCodes.includes(code)
              ? { ...g, stockCodes: g.stockCodes.filter(c => c !== code) }
              : { ...g, stockCodes: [...g.stockCodes, code] };
          }),
        });
      },
      moveStocksToGroup: (codes, targetId, fromId) => {
        const moving = new Set(codes);
        set({
          groups: get().groups.map(g => {
            let stockCodes = g.stockCodes;
            if (fromId && g.id === fromId) stockCodes = stockCodes.filter(c => !moving.has(c));
            if (targetId && g.id === targetId) stockCodes = [...new Set([...stockCodes, ...codes])];
            return stockCodes === g.stockCodes ? g : { ...g, stockCodes };
          }),
        });
      },
      reorderStocks: (orderedCodes, groupId) => {
        if (groupId) {
          set({
            groups: get().groups.map(g => (g.id === groupId ? { ...g, stockCodes: orderedCodes } : g)),
          });
        } else {
          const rank = new Map(orderedCodes.map((c, i) => [c, i]));
          set({
            watchlist: [...get().watchlist].sort(
              (a, b) => (rank.get(a.code) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.code) ?? Number.MAX_SAFE_INTEGER)
            ),
          });
        }
      },
      reorderGroups: (orderedIds) => {
        const rank = new Map(orderedIds.map((id, i) => [id, i]));
        set({
          groups: [...get().groups].sort(
            (a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER)
          ),
        });
      },
      addGroup: (name) => {
        const trimmed = name.trim();
        if (!trimmed || trimmed.length > 12) return false;
        if (get().groups.some(g => g.name === trimmed)) return false;
        set({ groups: [...get().groups, { id: generateId(), name: trimmed, stockCodes: [] }] });
        return true;
      },
      renameGroup: (groupId, name) => {
        const trimmed = name.trim();
        if (!trimmed || trimmed.length > 12) return false;
        if (get().groups.some(g => g.id !== groupId && g.name === trimmed)) return false;
        set({ groups: get().groups.map(g => g.id === groupId ? { ...g, name: trimmed } : g) });
        return true;
      },
      deleteGroup: (groupId, withStocks = false) => {
        const { groups, watchlist, alerts } = get();
        const groupCodes = new Set(groups.find(g => g.id === groupId)?.stockCodes ?? []);
        // 其余分组持有的标的（用于"连标的删"时保留同时在其他组的标的）
        const otherCodes = new Set(groups.filter(g => g.id !== groupId).flatMap(g => g.stockCodes));
        const toRemove = withStocks
          ? new Set(watchlist.filter(s => groupCodes.has(s.code) && !otherCodes.has(s.code)).map(s => s.code))
          : new Set<string>();
        set({
          groups: groups.filter(g => g.id !== groupId),
          watchlist: watchlist.filter(s => !toRemove.has(s.code)),
          alerts: toRemove.size > 0 ? alerts.filter(a => !toRemove.has(a.stockCode)) : alerts,
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
      // 旧数据升级：
      // v3 多组映射——历史 'default' 组删除、其成员归位未分组；标的的 groupId 收集进对应组的 stockCodes；
      // v1/v2 从任意版本上来都过同一套迁移（无 groupId 概念的数据自然通过）
      version: 3,
      migrate: (persistedState: any) => {
        const state = { ...(persistedState ?? {}) };
        const groups: WatchlistGroup[] = (Array.isArray(state.groups) ? state.groups : [])
          .filter((g: WatchlistGroup) => g.id !== 'default')
          .map((g: any) => ({ ...g, stockCodes: Array.isArray(g.stockCodes) ? g.stockCodes : [] }));
        const watchlist = (state.watchlist ?? []).map((s: any) => {
          const { groupId, ...rest } = s;
          if (groupId && groupId !== 'default') {
            const g = groups.find(x => x.id === groupId);
            if (g && !g.stockCodes.includes(s.code)) g.stockCodes.push(s.code);
          }
          return rest;
        });
        return { ...state, groups, watchlist };
      },
    }
  )
);
