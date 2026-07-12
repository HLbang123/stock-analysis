import { create } from 'zustand';
import type { StockInfo, Quote, ChartPeriod } from '../types';

interface StockState {
  // Current stock
  selectedStock: StockInfo | null;
  quote: Quote | null;
  isQuoteLoading: boolean;

  // Chart settings
  period: ChartPeriod;
  showMA5: boolean;
  showMA10: boolean;
  showMA20: boolean;
  showVolume: boolean;

  // Watchlist (persisted to localStorage)
  watchlist: StockInfo[];

  // Actions
  selectStock: (stock: StockInfo | null) => void;
  setQuote: (quote: Quote | null) => void;
  setQuoteLoading: (loading: boolean) => void;
  setPeriod: (period: ChartPeriod) => void;
  toggleMA5: () => void;
  toggleMA10: () => void;
  toggleMA20: () => void;
  toggleVolume: () => void;
  addToWatchlist: (stock: StockInfo) => void;
  removeFromWatchlist: (code: string) => void;
  isInWatchlist: (code: string) => boolean;
}

export const useStockStore = create<StockState>((set, get) => ({
  selectedStock: null,
  quote: null,
  isQuoteLoading: false,
  period: 'daily',
  showMA5: true,
  showMA10: true,
  showMA20: true,
  showVolume: true,
  watchlist: JSON.parse(localStorage.getItem('watchlist') || '[]'),

  selectStock: (stock) => set({ selectedStock: stock, quote: null }),
  setQuote: (quote) => set({ quote }),
  setQuoteLoading: (loading) => set({ isQuoteLoading: loading }),

  setPeriod: (period) => set({ period }),
  toggleMA5: () => set((s) => ({ showMA5: !s.showMA5 })),
  toggleMA10: () => set((s) => ({ showMA10: !s.showMA10 })),
  toggleMA20: () => set((s) => ({ showMA20: !s.showMA20 })),
  toggleVolume: () => set((s) => ({ showVolume: !s.showVolume })),

  addToWatchlist: (stock) => {
    const current = get().watchlist;
    if (current.find((s) => s.code === stock.code)) return;
    const updated = [...current, stock];
    localStorage.setItem('watchlist', JSON.stringify(updated));
    set({ watchlist: updated });
  },

  removeFromWatchlist: (code) => {
    const updated = get().watchlist.filter((s) => s.code !== code);
    localStorage.setItem('watchlist', JSON.stringify(updated));
    set({ watchlist: updated });
  },

  isInWatchlist: (code) => {
    return get().watchlist.some((s) => s.code === code);
  },
}));
