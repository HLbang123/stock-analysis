'use client';

import React, { useEffect, useRef, useCallback } from 'react';
import {
  createChart,
  IChartApi,
  CandlestickSeries,
  HistogramSeries,
  Time,
  ColorType,
  LineStyle,
} from 'lightweight-charts';
import { KLineData } from '@/types';
import { useTheme } from '@/components/providers/theme-provider';

interface PriceLine {
  price: number;
  color?: string;
}

interface KLineChartProps {
  data: KLineData[];
  height?: number;
  showVolume?: boolean;
  levels?: PriceLine[]; // 支撑/压力水平线
  onBarClick?: (index: number) => void;
}

export function KLineChart({
  data,
  height = 400,
  showVolume = true,
  levels = [],
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
      // 只允许左右滑动 + 横向缩放（双指捏合/滚轮/时间轴拖拽）；纵向锁死自适应
      handleScroll: {
        mouseWheel: false,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: { time: true, price: false },
        axisDoubleClickReset: false,
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

    // 支撑/压力水平线（createPriceLine 虚线）。名称不进图（title 会画在 canvas 上遮挡 K 线），
    // 由调用方在图外渲染图例；这里只留右侧价格轴标签
    levels.forEach(lv => {
      candleSeries.createPriceLine({
        price: lv.price,
        color: lv.color ?? '#3b82f6',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
      });
    });

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

    // 默认只展示最近 30 根 K 线（rightOffset 3 格留白），更早的左右滑动查看
    const to = candleData.length - 1 + 3;
    const from = Math.max(0, candleData.length - 30);
    chart.timeScale().setVisibleLogicalRange({ from, to });
    chartRef.current = chart;
    return chart;
  }, [data, showVolume, height, onBarClick, resolvedTheme, levels]);

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
