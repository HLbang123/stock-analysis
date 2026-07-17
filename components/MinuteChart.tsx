'use client';

import React, { useEffect, useRef, useCallback } from 'react';
import {
  createChart,
  IChartApi,
  LineSeries,
  AreaSeries,
  Time,
  ColorType,
} from 'lightweight-charts';
import { useTheme } from '@/components/providers/theme-provider';

/** 将 "0930" 格式转为 Unix 时间戳（秒） */
function toTime(hhmm: string): Time {
  const now = new Date();
  const h = parseInt(hhmm.slice(0, 2)) || 0;
  const m = parseInt(hhmm.slice(2, 4)) || 0;
  return (new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m).getTime() / 1000) as Time;
}

interface MinutePoint {
  time: string;   // "0930"
  price: number;
  volume: number;
  avgPrice: number;
}

interface MinuteChartProps {
  data: MinutePoint[];
  prevClose: number;
  height?: number;
  alertMarkers?: { index: number; number: number; level: string }[];
}

export function MinuteChart({
  data,
  prevClose,
  height = 350,
  alertMarkers = [],
}: MinuteChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const { resolvedTheme } = useTheme();

  const initChart = useCallback(() => {
    if (!containerRef.current || data.length === 0) return;

    if (chartRef.current) {
      chartRef.current.remove();
      chartRef.current = null;
    }

    const isDark = resolvedTheme === 'dark';

    const chart = createChart(containerRef.current, {
      height,
      layout: {
        background: { type: ColorType.Solid, color: isDark ? '#111827' : '#ffffff' },
        textColor: isDark ? '#9ca3af' : '#6b7280',
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: isDark ? '#1f2937' : '#f3f4f6' },
        horzLines: { color: isDark ? '#1f2937' : '#f3f4f6' },
      },
      rightPriceScale: {
        borderColor: isDark ? '#374151' : '#e5e7eb',
      },
      timeScale: {
        borderColor: isDark ? '#374151' : '#e5e7eb',
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time: number) => {
          const d = new Date(time * 1000);
          return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        },
        rightOffset: 2,
        fixLeftEdge: true,
        barSpacing: 6,
      },
      crosshair: {
        mode: 1,
        vertLine: { color: isDark ? '#374151' : '#d1d5db', style: 2, labelVisible: true },
        horzLine: { color: isDark ? '#374151' : '#d1d5db', style: 2, labelVisible: true },
      },
    });

    // 昨收线
    const prevCloseSeries = chart.addSeries(LineSeries, {
      color: isDark ? '#6b7280' : '#9ca3af',
      lineWidth: 1,
      lineStyle: 2, // dashed
      priceLineVisible: false,
      lastValueVisible: false,
    });

    // 添加从头到尾的昨收线
    if (data.length > 0) {
      prevCloseSeries.setData([
        { time: toTime(data[0].time), value: prevClose },
        { time: toTime(data[data.length - 1].time), value: prevClose },
      ]);
    }

    // 价格线（面积图）
    const priceSeries = chart.addSeries(AreaSeries, {
      lineColor: '#3b82f6',
      lineWidth: 1,
      topColor: 'rgba(59, 130, 246, 0.3)',
      bottomColor: 'rgba(59, 130, 246, 0.02)',
      priceLineVisible: false,
    });

    const priceData = data.map(p => ({
      time: toTime(p.time),
      value: p.price,
    }));
    priceSeries.setData(priceData);

    // 均线
    if (data.some(p => p.avgPrice > 0)) {
      const avgSeries = chart.addSeries(LineSeries, {
        color: '#f59e0b',
        lineWidth: 1,
        lineStyle: 0,
        priceLineVisible: false,
        lastValueVisible: false,
      });

      const avgData = data
        .filter(p => p.avgPrice > 0)
        .map(p => ({ time: toTime(p.time), value: p.avgPrice }));
      avgSeries.setData(avgData);
    }

    // 预警标记 — v5 中用独立 LineSeries 绘制
    if (alertMarkers.length > 0) {
      const seenTimes = new Set<number>();
      const markerPoints: { time: Time; value: number }[] = [];
      alertMarkers.forEach(m => {
        const point = data[m.index];
        if (!point) return;
        const t = toTime(point.time) as number;
        if (seenTimes.has(t)) return; // 去重：同一时刻只保留一个标记
        seenTimes.add(t);
        markerPoints.push({
          time: t as Time,
          value: point.price * 1.005,
        });
      });
      if (markerPoints.length > 0) {
        // 按时间升序排列（lightweight-charts 要求）
        markerPoints.sort((a, b) => (a.time as number) - (b.time as number));
        const markerSeries = chart.addSeries(LineSeries, {
          lineVisible: false,
          lastValueVisible: false,
          priceLineVisible: false,
          color: '#ef4444',
          pointMarkersVisible: true,
        });
        markerSeries.setData(markerPoints);
      }
    }

    chart.timeScale().fitContent();
    chartRef.current = chart;

    return chart;
  }, [data, prevClose, height, resolvedTheme, alertMarkers]);

  useEffect(() => {
    const chart = initChart();

    const handleResize = () => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({ width: containerRef.current.clientWidth });
      }
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
      }
    };
  }, [initChart]);

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center text-gray-400" style={{ height }}>
        <div className="text-center">
          <p>暂无分时数据</p>
          <p className="text-xs mt-1">非交易时段不提供分时数据</p>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full overflow-hidden rounded-lg">
      <div ref={containerRef} style={{ width: '100%', height: `${height}px` }} />
    </div>
  );
}
