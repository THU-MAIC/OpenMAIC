'use client';

import { useEffect, useRef, useMemo } from 'react';
import tinycolor from 'tinycolor2';
import type { ChartData, ChartOptions, ChartType } from '@openmaic/dsl';
import { getChartOption } from './chartOption';

import type { ECharts } from 'echarts/core';
import { createLogger } from '@/lib/logger';
import { loadChartRuntime } from './chart-runtime';

const log = createLogger('Chart');

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
  const chartInstance = useRef<ECharts | null>(null);

  // Generate theme colors
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

  // Update chart option
  const updateOption = useMemo(() => {
    return () => {
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
    };
  }, [type, data, themeColors, textColor, lineColor, options]);

  // Read by the initial draw, which runs once the chart library has loaded and
  // must use the props of that moment rather than those of the first render.
  const latestUpdateOption = useRef(updateOption);

  // Update chart when props change
  useEffect(() => {
    latestUpdateOption.current = updateOption;
    updateOption();
  }, [updateOption]);

  // Initialize chart
  useEffect(() => {
    const container = chartRef.current;
    if (!container) return;

    let disposed = false;
    let resizeObserver: ResizeObserver | undefined;
    loadChartRuntime()
      .then((echarts) => {
        if (disposed) return;
        chartInstance.current = echarts.init(container, null, {
          renderer: 'svg',
        });
        latestUpdateOption.current();

        resizeObserver = new ResizeObserver(() => {
          chartInstance.current?.resize();
        });
        resizeObserver.observe(container);
      })
      .catch((error: unknown) => {
        log.warn('Chart library failed to load', error);
      });

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      chartInstance.current?.dispose();
      chartInstance.current = null;
    };
  }, []);

  return <div ref={chartRef} className="chart w-full h-full" />;
}
