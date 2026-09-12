'use client';

import { useEffect, useRef, useMemo, useState, useCallback } from 'react';
import tinycolor from 'tinycolor2';
import type { ChartData, ChartOptions, ChartType } from '@openmaic/dsl';
import { getChartOption } from './chartOption';
import { loadChartRuntime } from './chartRuntime';

interface ChartProps {
  width: number;
  height: number;
  type: ChartType;
  data: ChartData;
  themeColors: string[];
  textColor?: string;
  lineColor?: string;
  options?: ChartOptions;
}

export function Chart({
  width: _width,
  height: _height,
  type,
  data,
  themeColors: rawThemeColors,
  textColor,
  lineColor,
  options,
}: ChartProps) {
  const chartRef = useRef<HTMLDivElement>(null);
  const chartInstance = useRef<import('echarts/core').ECharts | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const updateOptionRef = useRef<() => void>(() => undefined);
  const [chartState, setChartState] = useState<'loading' | 'ready' | 'error'>('loading');

  const themeColors = useMemo(() => {
    let colors: string[] = [];
    if (rawThemeColors.length >= 10) {
      colors = rawThemeColors;
    } else if (rawThemeColors.length === 1) {
      colors = tinycolor(rawThemeColors[0])
        .analogous(10)
        .map((color) => color.toRgbString());
    } else {
      const len = rawThemeColors.length;
      const supplement = tinycolor(rawThemeColors[len - 1])
        .analogous(10 + 1 - len)
        .map((color) => color.toRgbString());
      colors = [...rawThemeColors.slice(0, len - 1), ...supplement];
    }
    return colors;
  }, [rawThemeColors]);

  const updateOption = useCallback(() => {
    if (!chartInstance.current) return;

    const option = getChartOption({
      type,
      data,
      themeColors,
      textColor,
      lineColor,
      lineSmooth: options?.lineSmooth || false,
      stack: options?.stack || false,
    });

    if (option) {
      chartInstance.current.setOption(option, true);
    }
  }, [type, data, themeColors, textColor, lineColor, options]);

  useEffect(() => {
    updateOptionRef.current = updateOption;
  }, [updateOption]);

  useEffect(() => {
    let mounted = true;

    void loadChartRuntime()
      .then((echarts) => {
        if (!mounted || !chartRef.current) return;

        chartInstance.current = echarts.init(chartRef.current, null, { renderer: 'svg' });
        setChartState('ready');
        updateOptionRef.current();

        const resizeObserver = new ResizeObserver(() => {
          chartInstance.current?.resize();
        });
        resizeObserver.observe(chartRef.current);
        resizeObserverRef.current = resizeObserver;
      })
      .catch(() => {
        if (mounted) setChartState('error');
      });

    return () => {
      mounted = false;
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      chartInstance.current?.dispose();
      chartInstance.current = null;
    };
    // The runtime and ECharts instance are initialized once per mounted chart.
    // Option changes are applied by the effect below without re-initializing.
  }, []);

  useEffect(() => {
    updateOption();
  }, [updateOption]);

  return (
    <div
      ref={chartRef}
      className="chart"
      data-chart-state={chartState}
      aria-busy={chartState === 'loading'}
      style={{ width: '100%', height: '100%' }}
    />
  );
}
