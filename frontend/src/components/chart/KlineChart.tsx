import { useEffect, useRef } from 'react';
import {
  createChart,
  ColorType,
  type IChartApi,
  type ISeriesApi,
  type CandlestickSeriesPartialOptions,
  type LineSeriesPartialOptions,
  type HistogramSeriesPartialOptions,
  CrosshairMode,
} from 'lightweight-charts';
import type { Kline } from '../../types';
import { CHART_COLORS } from '../../utils/colors';

interface Props {
  klines: Kline[];
  ma5Values: (number | null)[];
  ma10Values: (number | null)[];
  ma20Values: (number | null)[];
  showMA5: boolean;
  showMA10: boolean;
  showMA20: boolean;
  showVolume: boolean;
}

export default function KlineChart({
  klines,
  ma5Values,
  ma10Values,
  ma20Values,
  showMA5,
  showMA10,
  showMA20,
  showVolume,
}: Props) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const ma5SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const ma10SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const ma20SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);

  // Initialize chart
  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: CHART_COLORS.background },
        textColor: CHART_COLORS.text,
      },
      grid: {
        vertLines: { color: CHART_COLORS.grid },
        horzLines: { color: CHART_COLORS.grid },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: CHART_COLORS.crosshair },
        horzLine: { color: CHART_COLORS.crosshair },
      },
      rightPriceScale: {
        borderColor: CHART_COLORS.grid,
        scaleMargins: { top: 0.1, bottom: 0.2 },
      },
      timeScale: {
        borderColor: CHART_COLORS.grid,
        timeVisible: true,
        secondsVisible: false,
      },
    });

    // Candlestick series
    const candleOptions: CandlestickSeriesPartialOptions = {
      upColor: CHART_COLORS.bullishCandle,
      downColor: CHART_COLORS.bearishCandle,
      borderUpColor: CHART_COLORS.bullishCandle,
      borderDownColor: CHART_COLORS.bearishCandle,
      wickUpColor: CHART_COLORS.bullishCandle,
      wickDownColor: CHART_COLORS.bearishCandle,
    };
    const candleSeries = chart.addCandlestickSeries(candleOptions);
    candleSeriesRef.current = candleSeries;

    // Volume histogram (on separate pane)
    const volumeOptions: HistogramSeriesPartialOptions = {
      priceScaleId: 'volume',
    };
    const volumeSeries = chart.addHistogramSeries(volumeOptions);
    volumeSeriesRef.current = volumeSeries;
    chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });

    // MA line series
    ma5SeriesRef.current = chart.addLineSeries({
      color: CHART_COLORS.ma5,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    ma10SeriesRef.current = chart.addLineSeries({
      color: CHART_COLORS.ma10,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    ma20SeriesRef.current = chart.addLineSeries({
      color: CHART_COLORS.ma20,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    chartRef.current = chart;

    // Resize handler
    const handleResize = () => {
      if (chartContainerRef.current) {
        chart.applyOptions({
          width: chartContainerRef.current.clientWidth,
          height: chartContainerRef.current.clientHeight,
        });
      }
    };

    const observer = new ResizeObserver(handleResize);
    observer.observe(chartContainerRef.current);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  // Update data when klines change
  useEffect(() => {
    if (!chartRef.current || !candleSeriesRef.current || !volumeSeriesRef.current) return;

    const candleData = klines.map((k) => ({
      time: formatDateToTime(k.date),
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
    }));

    const volumeData = klines.map((k) => ({
      time: formatDateToTime(k.date),
      value: k.volume,
      color: k.close >= k.open
        ? CHART_COLORS.volumeUp
        : CHART_COLORS.volumeDown,
    }));

    candleSeriesRef.current.setData(candleData);
    volumeSeriesRef.current.setData(volumeData);

    // Update MA lines
    function setMAData(series: ISeriesApi<'Line'> | null, values: (number | null)[], visible: boolean) {
      if (!series) return;
      if (!visible) {
        series.setData([]);
        return;
      }
      const data = values
        .map((v, i) => (v !== null ? { time: formatDateToTime(klines[i].date), value: v } : null))
        .filter((d): d is { time: string; value: number } => d !== null);
      series.setData(data);
    }

    setMAData(ma5SeriesRef.current, ma5Values, showMA5);
    setMAData(ma10SeriesRef.current, ma10Values, showMA10);
    setMAData(ma20SeriesRef.current, ma20Values, showMA20);

    // Fit content
    chartRef.current.timeScale().fitContent();
  }, [klines, ma5Values, ma10Values, ma20Values, showMA5, showMA10, showMA20]);

  // Toggle volume visibility
  useEffect(() => {
    if (!chartRef.current || !volumeSeriesRef.current) return;
    volumeSeriesRef.current.applyOptions({
      visible: showVolume,
    });
  }, [showVolume]);

  return (
    <div ref={chartContainerRef} className="w-full h-full min-h-[400px]" />
  );
}

/**
 * Convert date string (YYYYMMDD or YYYY-MM-DD) to time format for lightweight-charts.
 */
function formatDateToTime(date: string): string {
  const cleaned = date.replace(/-/g, '');
  if (cleaned.length === 8) {
    return `${cleaned.slice(0, 4)}-${cleaned.slice(4, 6)}-${cleaned.slice(6, 8)}`;
  }
  return date;
}
