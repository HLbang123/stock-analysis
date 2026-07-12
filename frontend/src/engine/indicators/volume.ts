import type { Kline } from '../../types';

export interface VolumeAnalysis {
  avgVol5: number;      // 5-day average volume
  avgVol20: number;     // 20-day average volume
  maxVolYear: number;   // Max volume in last 250 bars
  maxVolAll: number;    // Max volume in all data
  lastVol: number;      // Most recent volume
  volRatio5: number;    // lastVol / avgVol5
  volRatio20: number;   // lastVol / avgVol20
  isHighVolume: boolean; // lastVol > avgVol5 * 1.2
}

/**
 * Analyze volume characteristics for a set of K-lines.
 */
export function analyzeVolume(klines: Kline[]): VolumeAnalysis {
  if (klines.length === 0) {
    return {
      avgVol5: 0, avgVol20: 0, maxVolYear: 0, maxVolAll: 0,
      lastVol: 0, volRatio5: 0, volRatio20: 0, isHighVolume: false,
    };
  }

  const volumes = klines.map(k => k.volume);
  const last = volumes[volumes.length - 1];
  const lastVol = last || 0;

  // 5-day average
  const recent5 = volumes.slice(-5);
  const avgVol5 = recent5.reduce((a, b) => a + b, 0) / Math.max(recent5.length, 1);

  // 20-day average
  const recent20 = volumes.slice(-20);
  const avgVol20 = recent20.reduce((a, b) => a + b, 0) / Math.max(recent20.length, 1);

  // Year max (last ~250 bars)
  const yearSlice = volumes.slice(-250);
  const maxVolYear = yearSlice.length > 0 ? Math.max(...yearSlice) : 0;

  // All-time max
  const maxVolAll = volumes.length > 0 ? Math.max(...volumes) : 0;

  const volRatio5 = avgVol5 > 0 ? lastVol / avgVol5 : 0;
  const volRatio20 = avgVol20 > 0 ? lastVol / avgVol20 : 0;
  const isHighVolume = volRatio5 > 1.2;

  return {
    avgVol5, avgVol20, maxVolYear, maxVolAll,
    lastVol, volRatio5, volRatio20, isHighVolume,
  };
}
