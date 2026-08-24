'use client';

import { useEffect, useMemo, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useTheme } from '@/lib/hooks/use-theme';
import type { ChatVM } from '@/lib/report/types';

echarts.use([BarChart, GridComponent, TooltipComponent, LegendComponent, SVGRenderer]);

export function ChatChart({ chat }: { chat: ChatVM[] }) {
  const { t } = useI18n();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const ref = useRef<HTMLDivElement>(null);
  const inst = useRef<echarts.ECharts | null>(null);

  // Only stages that actually have chat sessions.
  const items = useMemo(() => chat.filter((c) => c.total > 0), [chat]);

  useEffect(() => {
    if (!ref.current || items.length === 0) return;
    if (!inst.current) inst.current = echarts.init(ref.current, undefined, { renderer: 'svg' });
    const chart = inst.current;
    const axis = isDark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.45)';
    const split = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
    const cLecture = isDark ? '#a78bfa' : '#7c3aed'; // violet
    const cQa = isDark ? '#38bdf8' : '#0ea5e9'; // sky
    const cDiscussion = isDark ? '#34d399' : '#10b981'; // emerald

    const truncate = (s: string) => (s.length > 10 ? s.slice(0, 9) + '…' : s);

    chart.setOption({
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: {
        data: [
          t('learningReport.chat.lecture'),
          t('learningReport.chat.qa'),
          t('learningReport.chat.discussion'),
        ],
        textStyle: { color: axis },
        top: 0,
      },
      grid: { left: 90, right: 16, top: 36, bottom: 16 },
      xAxis: {
        type: 'value',
        minInterval: 1,
        axisLabel: { color: axis, fontSize: 11 },
        splitLine: { lineStyle: { color: split } },
      },
      yAxis: {
        type: 'category',
        data: items.map((c) => truncate(c.stageName)),
        axisLabel: { color: axis, fontSize: 11 },
        axisLine: { lineStyle: { color: split } },
        axisTick: { show: false },
      },
      series: [
        {
          name: t('learningReport.chat.lecture'),
          type: 'bar',
          stack: 'total',
          itemStyle: { color: cLecture },
          data: items.map((c) => c.lecture),
        },
        {
          name: t('learningReport.chat.qa'),
          type: 'bar',
          stack: 'total',
          itemStyle: { color: cQa },
          data: items.map((c) => c.qa),
        },
        {
          name: t('learningReport.chat.discussion'),
          type: 'bar',
          stack: 'total',
          itemStyle: { color: cDiscussion },
          data: items.map((c) => c.discussion),
        },
      ],
    });
    chart.resize();
  }, [items, isDark, t]);

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
    return <p className="text-sm text-muted-foreground">{t('learningReport.chat.empty')}</p>;
  }
  return <div ref={ref} style={{ width: '100%', height: Math.max(160, items.length * 44 + 60) }} />;
}
