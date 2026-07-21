'use client';

import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, HeatmapChart, GaugeChart, TreemapChart } from 'echarts/charts';
import {
  GridComponent, TooltipComponent, LegendComponent, VisualMapComponent,
  DataZoomComponent, MarkLineComponent, GraphicComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  BarChart, LineChart, HeatmapChart, GaugeChart, TreemapChart,
  GridComponent, TooltipComponent, LegendComponent, VisualMapComponent,
  DataZoomComponent, MarkLineComponent, GraphicComponent, CanvasRenderer,
]);

interface EChartProps {
  option: any;
  className?: string;
  style?: React.CSSProperties;
}

export function EChart({ option, className, style }: EChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = echarts.init(containerRef.current, undefined, { renderer: 'canvas' });
    chartRef.current = chart;
    const onResize = () => chart.resize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (chartRef.current && option) {
      chartRef.current.setOption(option, true);
    }
  }, [option]);

  return <div ref={containerRef} className={className} style={{ width: '100%', height: '100%', ...style }} />;
}
