'use client';

import { useEffect, useRef, useMemo } from 'react';
import tinycolor from 'tinycolor2';
import type { ChartData, ChartOptions, ChartType } from '@/lib/types/slides';
import { getChartOption } from './chartOption';

import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart, ScatterChart, RadarChart } from 'echarts/charts';
import { LegendComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  ScatterChart,
  RadarChart,
  LegendComponent,
  SVGRenderer,
]);

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
  const chartInstance = useRef<echarts.ECharts | null>(null);

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

  // Initialize chart
  useEffect(() => {
    if (!chartRef.current) return;

    chartInstance.current = echarts.init(chartRef.current, null, {
      renderer: 'svg',
    });
    updateOption();

    const resizeObserver = new ResizeObserver(() => {
      chartInstance.current?.resize();
    });
    resizeObserver.observe(chartRef.current);

    return () => {
      resizeObserver.disconnect();
      chartInstance.current?.dispose();
      chartInstance.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Init-only effect: chart setup and resize observer
  }, []);

  // Update chart when props change
  useEffect(() => {
    updateOption();
  }, [updateOption]);

  return <div ref={chartRef} className="chart w-full h-full" />;
}
