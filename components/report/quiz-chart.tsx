'use client';

import { useEffect, useMemo, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useTheme } from '@/lib/hooks/use-theme';
import type { QuizVM } from '@/lib/report/types';

echarts.use([BarChart, GridComponent, TooltipComponent, SVGRenderer]);

/** Score-ratio color band, matching the report platform's scoreColor(). */
function scoreColor(ratio: number, isDark: boolean): string {
  if (ratio < 0.4) return isDark ? '#f87171' : '#ef4444'; // red
  if (ratio < 0.7) return isDark ? '#fbbf24' : '#f59e0b'; // amber
  return isDark ? '#a78bfa' : '#7c3aed'; // violet (primary)
}

export function QuizChart({ quiz }: { quiz: QuizVM[] }) {
  const { t } = useI18n();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const ref = useRef<HTMLDivElement>(null);
  const inst = useRef<echarts.ECharts | null>(null);

  // Quiz submissions have no local timestamp; keep source order (per stage).
  const items = useMemo(() => quiz, [quiz]);

  useEffect(() => {
    if (!ref.current || items.length === 0) return;
    if (!inst.current) inst.current = echarts.init(ref.current, undefined, { renderer: 'svg' });
    const chart = inst.current;
    const axis = isDark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.45)';
    const split = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';

    chart.setOption({
      tooltip: {
        trigger: 'axis',
        formatter: (params: unknown) => {
          const p = (params as { dataIndex: number }[])[0];
          const it = items[p.dataIndex];
          return `${it.stageName}<br/>${it.score} / ${it.totalPoints} · ${Math.round(
            it.scoreRatio * 100,
          )}%`;
        },
      },
      grid: { left: 40, right: 16, top: 16, bottom: 24 },
      xAxis: {
        type: 'category',
        data: items.map((_, i) => String(i + 1)),
        axisLabel: { color: axis, fontSize: 11 },
        axisLine: { lineStyle: { color: split } },
        axisTick: { show: false },
      },
      yAxis: {
        type: 'value',
        max: 100,
        axisLabel: { color: axis, fontSize: 11, formatter: '{value}%' },
        splitLine: { lineStyle: { color: split } },
      },
      series: [
        {
          type: 'bar',
          barMaxWidth: 28,
          data: items.map((it) => ({
            value: Math.round(it.scoreRatio * 100),
            itemStyle: { color: scoreColor(it.scoreRatio, isDark), borderRadius: [4, 4, 0, 0] },
          })),
        },
      ],
    });
    chart.resize();
  }, [items, isDark]);

  useEffect(() => {
    const onResize = () => inst.current?.resize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      inst.current?.dispose();
      inst.current = null;
    };
  }, []);

  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('learningReport.quiz.empty')}</p>;
  }
  return <div ref={ref} style={{ width: '100%', height: 220 }} />;
}
