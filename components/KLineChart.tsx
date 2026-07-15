'use client';

import React, { useEffect, useRef, useCallback } from 'react';
import {
  createChart,
  IChartApi,
  ISeriesApi,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  Time,
  ColorType,
} from 'lightweight-charts';
import { KLineData } from '@/types';
import { useTheme } from '@/components/providers/theme-provider';

interface AlertMarker {
  barIndex: number;
  number: number;
  level: string;
}

interface KLineChartProps {
  data: KLineData[];
  height?: number;
  showVolume?: boolean;
  alertMarkers?: AlertMarker[];
  onBarClick?: (index: number) => void;
}

export function KLineChart({
  data,
  height = 400,
  showVolume = true,
  alertMarkers = [],
  onBarClick,
}: KLineChartProps) {
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
      crosshair: {
        mode: 1,
        vertLine: { color: isDark ? '#374151' : '#d1d5db', style: 2, width: 1, labelVisible: true },
        horzLine: { color: isDark ? '#374151' : '#d1d5db', style: 2, width: 1, labelVisible: true },
      },
      rightPriceScale: {
        borderColor: isDark ? '#374151' : '#e5e7eb',
        scaleMargins: showVolume ? { top: 0.05, bottom: 0.25 } : { top: 0.05, bottom: 0.05 },
      },
      timeScale: {
        borderColor: isDark ? '#374151' : '#e5e7eb',
        timeVisible: false,
        rightOffset: 3,
      },
    });

    // K线 (A股配色: 红涨绿跌)
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#ef4444',
      downColor: '#22c55e',
      borderUpColor: '#ef4444',
      borderDownColor: '#22c55e',
      wickUpColor: '#ef4444',
      wickDownColor: '#22c55e',
    });

    const candleData = data.map(k => {
      // 标准化日期格式 yyyy-mm-dd（腾讯API返回yyyyMMdd，新浪返回yyyy-mm-dd）
      const raw = (k.date || '').replace(/-/g, '');
      const time = raw.length === 8
        ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
        : raw;
      return {
        time: time as Time,
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
      };
    });

    candleSeries.setData(candleData);

    // 成交量
    if (showVolume) {
      const volumeSeries = chart.addSeries(HistogramSeries, {
        priceFormat: { type: 'volume' },
        priceScaleId: 'volume',
      });
      volumeSeries.priceScale().applyOptions({
        scaleMargins: { top: 0.75, bottom: 0.01 },
      });

      const volumeData = data.map(k => {
        const raw = (k.date || '').replace(/-/g, '');
        const time = raw.length === 8
          ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
          : raw;
        return {
          time: time as Time,
          value: k.volume,
          color: k.close >= k.open ? 'rgba(239, 68, 68, 0.5)' : 'rgba(34, 197, 94, 0.5)',
        };
      });

      volumeSeries.setData(volumeData);
    }

    // 预警标记 — v5 中用独立 LineSeries 绘制标记点
    if (alertMarkers.length > 0) {
      const markerPoints: { time: Time; value: number }[] = [];
      const markerColors: string[] = [];

      alertMarkers.forEach(m => {
        const kLine = data[m.barIndex];
        if (!kLine) return;
        const raw = (kLine.date || '').replace(/-/g, '');
        const time = raw.length === 8
          ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
          : raw;
        const color =
          m.level === 'CRITICAL' ? '#ef4444' :
          m.level === 'WARNING' ? '#f59e0b' : '#3b82f6';

        // 每个标记用单独的线序（lineVisible=false，只显示点标记），用不同偏移避免重叠
        for (let i = 0; i < markerPoints.length; i++) {
          if (markerPoints[i].time === time && Math.abs(markerPoints[i].value - kLine.high * 1.02) < 0.01) {
            markerPoints[i].value += (kLine.high - kLine.low) * 0.05; // 偏移避免重叠
          }
        }

        markerPoints.push({
          time: time as Time,
          value: kLine.high * 1.02 + markerPoints.length * (kLine.high - kLine.low) * 0.03,
        });
        markerColors.push(color);
      });

      // 为每个标记创建一个带颜色的散点series
      const uniqueColors = [...new Set(markerColors)];
      uniqueColors.forEach(color => {
        const colorPoints = markerPoints.filter((_, i) => markerColors[i] === color);
        if (colorPoints.length === 0) return;
        const markerSeries = chart.addSeries(LineSeries, {
          lineVisible: false,
          lastValueVisible: false,
          priceLineVisible: false,
          color: color,
          pointMarkersVisible: true,
        });
        markerSeries.setData(colorPoints);
      });
    }

    // 点击
    if (onBarClick) {
      chart.subscribeClick(param => {
        if (param.time && candleData.length > 0) {
          const timeStr = param.time as string;
          const index = candleData.findIndex(c => c.time === timeStr);
          if (index >= 0) onBarClick(index);
        }
      });
    }

    chart.timeScale().fitContent();
    chartRef.current = chart;
    return chart;
  }, [data, showVolume, height, onBarClick, resolvedTheme, alertMarkers]);

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
        <p>暂无K线数据</p>
      </div>
    );
  }

  return (
    <div className="w-full overflow-hidden rounded-lg">
      <div ref={containerRef} style={{ width: '100%', height: `${height}px` }} />
    </div>
  );
}
