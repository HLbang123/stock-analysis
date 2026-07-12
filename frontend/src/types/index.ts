// ======== Raw Data Types ========

export interface Kline {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
  amount: number;
}

export interface KlineData {
  code: string;
  name: string;
  klines: Kline[];
}

export interface Quote {
  code: string;
  market: string;
  fullCode: string;
  name: string;
  price: number;
  open: number;
  prevClose: number;
  high: number;
  low: number;
  volume: number;
  amount: number;
  change: number;
  changePercent: number;
}

export interface IndexData {
  code: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
}

export interface StockInfo {
  code: string;
  market: string;
  name: string;
  type: string;
}

// ======== Indicator Types ========

export interface IndicatorSet {
  ma5: number | null;
  ma10: number | null;
  ma20: number | null;
  ma5Values: (number | null)[];
  ma10Values: (number | null)[];
  ma20Values: (number | null)[];
  macd: { dif: number; dea: number; histogram: number } | null;
  macdValues: { dif: (number | null)[]; dea: (number | null)[]; histogram: (number | null)[] };
  rsi: number | null;
  rsiValues: (number | null)[];
  avgVol5: number;   // 5-day average volume
  avgVol20: number;  // 20-day average volume
  maxVolYear: number; // Max volume in the past year (~250 trading days)
}

// ======== Pattern Types ========

export type CandleType = 'doji' | 'hammer' | 'shootingStar' | 'longLowerShadow' | 'longUpperShadow' | 'marubozu' | 'normal';

export interface CandlePattern {
  type: CandleType;
  index: number;        // Position in kline array
  date: string;
  description: string;
}

export interface BoxRange {
  top: number;
  bottom: number;
  startIndex: number;
  endIndex: number;
  days: number;
}

export interface Wave2Pattern {
  found: boolean;
  phase: 'up' | 'pullback' | 'base' | 'breakout' | 'none';
  upStart?: number;         // Index of start of first up wave
  upPeak?: number;          // Index of peak
  pullbackEnd?: number;     // Index of pullback bottom
  breakoutIndex?: number;   // Index of breakout candle
  breakoutStrength?: number; // Breakout candle body %
  description?: string;
}

export interface WPattern {
  found: boolean;
  aEnd?: number;      // Index of A bottom
  bPeak?: number;     // Index of B peak
  cEnd?: number;      // Index of C bottom
  breakoutIndex?: number;
  description?: string;
}

// ======== Alert Types ========

export type AlertLevel = 0 | 1 | 2 | 3;
// 0 = blue (info/观察)
// 1 = green (buy/买入关注)
// 2 = orange (reduce/减仓)
// 3 = red (clear/清仓离场)

export interface Alert {
  id: string;
  level: AlertLevel;
  category: 'sell' | 'buy' | 'reverse' | 'info';
  rule: string;          // Rule name from doc (e.g. "放巨量破5日线")
  description: string;   // Human-readable trigger detail
  action: string;        // Suggested action (e.g. "全部清仓")
  timestamp: string;
}

// ======== Store Types ========

export type ChartPeriod = 'daily' | 'weekly' | 'monthly' | '30min';

export interface ChartSettings {
  period: ChartPeriod;
  showMA5: boolean;
  showMA10: boolean;
  showMA20: boolean;
  showVolume: boolean;
}
