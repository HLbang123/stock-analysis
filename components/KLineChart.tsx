'use client';

import React, { useMemo } from 'react';
import { KLineData } from '@/types';
import { formatPrice, formatVolume, cn } from '@/lib/utils';

interface KLineChartProps {
  data: KLineData[];
  height?: number;
  showVolume?: boolean;
  onBarClick?: (index: number) => void;
}

export function KLineChart({ data, height = 300, showVolume = true, onBarClick }: KLineChartProps) {
  const { chartData, volumeData, scales } = useMemo(() => {
    if (data.length === 0) {
      return { chartData: [], volumeData: [], scales: { minPrice: 0, maxPrice: 0, maxVolume: 0 } };
    }

    const prices = data.flatMap(d => [d.open, d.high, d.low, d.close]);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const priceRange = maxPrice - minPrice || 1;

    const volumes = data.map(d => d.volume);
    const maxVolume = Math.max(...volumes);

    const barWidth = Math.max(2, (800 / data.length) * 0.7);
    const spacing = Math.max(2, (800 / data.length) * 0.3);

    const chartData = data.map((d, i) => {
      const x = i * (barWidth + spacing);
      const yOpen = ((maxPrice - d.open) / priceRange) * (height * 0.8);
      const yClose = ((maxPrice - d.close) / priceRange) * (height * 0.8);
      const yHigh = ((maxPrice - d.high) / priceRange) * (height * 0.8);
      const yLow = ((maxPrice - d.low) / priceRange) * (height * 0.8);

      const isUp = d.close >= d.open;
      const bodyTop = Math.min(yOpen, yClose);
      const bodyHeight = Math.abs(yClose - yOpen) || 1;

      return {
        x,
        yHigh,
        yLow,
        bodyTop,
        bodyHeight,
        barWidth,
        isUp,
        date: d.date,
        index: i
      };
    });

    const volumeHeight = height * 0.15;
    const volumeData = data.map((d, i) => {
      const x = i * (barWidth + spacing);
      const y = height - volumeHeight;
      const h = (d.volume / maxVolume) * volumeHeight;
      const isUp = d.close >= d.open;
      return { x, y, h, barWidth, isUp, volume: d.volume, index: i };
    });

    return { chartData, volumeData, scales: { minPrice, maxPrice, maxVolume } };
  }, [data, height]);

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400">
        暂无数据
      </div>
    );
  }

  return (
    <div className="relative w-full" style={{ height }}>
      <svg className="w-full h-full" viewBox={`0 0 800 ${height}`} preserveAspectRatio="none">
        {/* 背景网格 */}
        {[0, 25, 50, 75, 100].map(p => (
          <line
            key={p}
            x1={0}
            y1={(p / 100) * (height * 0.8)}
            x2={800}
            y2={(p / 100) * (height * 0.8)}
            stroke="#e5e7eb"
            strokeDasharray="4"
            strokeWidth={0.5}
          />
        ))}

        {/* K线 */}
        {chartData.map((bar) => (
          <g key={bar.index} onClick={() => onBarClick?.(bar.index)} className="cursor-pointer">
            {/* 影线 */}
            <line
              x1={bar.x + bar.barWidth / 2}
              y1={bar.yHigh}
              x2={bar.x + bar.barWidth / 2}
              y2={bar.yLow}
              stroke={bar.isUp ? '#ef4444' : '#22c55e'}
              strokeWidth={1}
            />
            {/* 实体 */}
            <rect
              x={bar.x}
              y={bar.bodyTop}
              width={bar.barWidth}
              height={bar.bodyHeight}
              fill={bar.isUp ? '#ef4444' : '#22c55e'}
              opacity={0.9}
            />
          </g>
        ))}

        {/* 成交量 */}
        {showVolume && volumeData.map((bar) => (
          <rect
            key={`vol-${bar.index}`}
            x={bar.x}
            y={bar.y + bar.h}
            width={bar.barWidth}
            height={bar.h}
            fill={bar.isUp ? '#ef4444' : '#22c55e'}
            opacity={0.4}
            onClick={() => onBarClick?.(bar.index)}
            className="cursor-pointer"
          />
        ))}

        {/* 价格标签 */}
        {scales.maxPrice > 0 && (
          <text x="805" y="15" fontSize="10" fill="#9ca3af" textAnchor="start">
            {formatPrice(scales.maxPrice)}
          </text>
        )}
        {scales.minPrice > 0 && (
          <text x="805" y={height * 0.8 - 5} fontSize="10" fill="#9ca3af" textAnchor="start">
            {formatPrice(scales.minPrice)}
          </text>
        )}
      </svg>
    </div>
  );
}