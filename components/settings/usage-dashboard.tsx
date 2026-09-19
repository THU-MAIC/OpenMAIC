'use client';

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import { Loader2, RefreshCw, BarChart3 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useTheme } from '@/lib/hooks/use-theme';

echarts.use([LineChart, GridComponent, TooltipComponent, SVGRenderer]);

type UsageKind = 'llm' | 'image' | 'video' | 'tts' | 'asr';
type UsageUnit = 'token' | 'image' | 'second' | 'character';

interface Bucket {
  key: string;
  kind: UsageKind;
  unit: UsageUnit;
  requests: number;
  totalTokens: number;
  quantity: number;
}

interface UsageResponse {
  totals: { requests: number; llmTokens: number };
  byModel: Bucket[];
  byDay: Bucket[];
  byKind: Bucket[];
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

const KIND_LABEL_KEY: Record<UsageKind, string> = {
  llm: 'settings.usage.kindLlm',
  image: 'settings.usage.kindImage',
  video: 'settings.usage.kindVideo',
  tts: 'settings.usage.kindTts',
  asr: 'settings.usage.kindAsr',
};

const UNIT_LABEL_KEY: Record<UsageUnit, string> = {
  token: 'settings.usage.unitToken',
  image: 'settings.usage.unitImage',
  second: 'settings.usage.unitSecond',
  character: 'settings.usage.unitCharacter',
};

/** Display order of modality sections. */
const KIND_ORDER: UsageKind[] = ['llm', 'image', 'video', 'tts', 'asr'];

export function UsageDashboard() {
  const { t } = useI18n();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const chartRef = useRef<HTMLDivElement>(null);
  const chartInstance = useRef<echarts.ECharts | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/usage');
      const json = await res.json();
      if (json.success !== false) setData(json as UsageResponse);
    } catch {
      // best-effort
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const byDay = useMemo(() => data?.byDay ?? [], [data]);

  /** A single usage figure with its unit, for a model/kind bucket. */
  const usageValue = (b: Bucket): number => (b.kind === 'llm' ? b.totalTokens : b.quantity);
  const usageDisplay = (b: Bucket): string =>
    `${fmtNum(usageValue(b))} ${t(UNIT_LABEL_KEY[b.kind === 'llm' ? 'token' : b.unit])}`;

  // Group models by modality, in display order, dropping empty modalities.
  const sections = useMemo(() => {
    const byKind = new Map<UsageKind, { kindBucket?: Bucket; models: Bucket[] }>();
    for (const m of data?.byModel ?? []) {
      if (!byKind.has(m.kind)) byKind.set(m.kind, { models: [] });
      byKind.get(m.kind)!.models.push(m);
    }
    for (const k of data?.byKind ?? []) {
      if (byKind.has(k.kind)) byKind.get(k.kind)!.kindBucket = k;
    }
    return KIND_ORDER.filter((k) => byKind.has(k)).map((k) => ({
      kind: k,
      summary: byKind.get(k)!.kindBucket,
      models: byKind.get(k)!.models.sort((a, b) => b.requests - a.requests),
    }));
  }, [data]);

  // Daily REQUESTS trend — unit-agnostic so it works across all modalities.
  // Area-only with a soft gradient + faint line, theme-aware, to avoid the
  // harsh solid stroke in dark mode.
  useEffect(() => {
    if (!chartRef.current) return;
    if (!chartInstance.current) {
      chartInstance.current = echarts.init(chartRef.current, undefined, { renderer: 'svg' });
    }
    const chart = chartInstance.current;
    const axis = isDark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.45)';
    const split = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
    const accent = isDark ? '#a78bfa' : '#7c3aed'; // violet, matches primary

    chart.setOption({
      tooltip: { trigger: 'axis' },
      grid: { left: 44, right: 16, top: 16, bottom: 28 },
      xAxis: {
        type: 'category',
        data: byDay.map((b) => b.key),
        axisLabel: { color: axis, fontSize: 11 },
        axisLine: { lineStyle: { color: split } },
        axisTick: { show: false },
      },
      yAxis: {
        type: 'value',
        minInterval: 1,
        axisLabel: { color: axis, fontSize: 11 },
        splitLine: { lineStyle: { color: split } },
      },
      series: [
        {
          name: t('settings.usage.totalRequests'),
          type: 'line',
          smooth: true,
          symbol: 'circle',
          symbolSize: 5,
          itemStyle: { color: accent },
          // Faint, thin connecting line instead of a hard solid stroke.
          lineStyle: { color: accent, width: 1, opacity: isDark ? 0.5 : 0.7 },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: isDark ? 'rgba(167,139,250,0.35)' : 'rgba(124,58,237,0.25)' },
                { offset: 1, color: isDark ? 'rgba(167,139,250,0.02)' : 'rgba(124,58,237,0.02)' },
              ],
            },
          },
          data: byDay.map((b) => b.requests),
        },
      ],
    });
    chart.resize();
  }, [byDay, t, isDark]);

  useEffect(() => {
    const onResize = () => chartInstance.current?.resize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      chartInstance.current?.dispose();
      chartInstance.current = null;
    };
  }, []);

  const totals = data?.totals;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">{t('settings.usage.title')}</h3>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading} className="gap-1.5">
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          {t('settings.usage.refresh')}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground -mt-3">{t('settings.usage.disclaimer')}</p>

      {/* Per-modality summary chips — each with its own unit. */}
      {sections.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          <div className="rounded-lg border px-3 py-2 text-sm">
            <span className="text-muted-foreground">{t('settings.usage.totalRequests')}</span>
            <span className="ml-2 font-medium">{totals?.requests ?? 0}</span>
          </div>
          {sections.map(
            (s) =>
              s.summary && (
                <div key={s.kind} className="rounded-lg border px-3 py-2 text-sm">
                  <span className="text-muted-foreground">{t(KIND_LABEL_KEY[s.kind])}</span>
                  <span className="ml-2 font-medium">{usageDisplay(s.summary)}</span>
                  <span className="ml-1 text-xs text-muted-foreground">({s.summary.requests})</span>
                </div>
              ),
          )}
        </div>
      ) : null}

      {/* Daily request trend — unit-agnostic across modalities. */}
      <div className="rounded-lg border p-3">
        <div className="text-xs text-muted-foreground mb-2">{t('settings.usage.dailyTrend')}</div>
        {byDay.length > 0 ? (
          <div ref={chartRef} style={{ width: '100%', height: 200 }} />
        ) : (
          <div className="h-[120px] flex items-center justify-center text-sm text-muted-foreground">
            {t('settings.usage.empty')}
          </div>
        )}
      </div>

      {/* Per-modality tables — each section's usage column shares one unit. */}
      {sections.map((s) => (
        <div key={s.kind} className="rounded-lg border overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/30">
            <span className="text-xs font-medium">{t(KIND_LABEL_KEY[s.kind])}</span>
            {s.summary && (
              <span className="text-xs text-muted-foreground">
                {usageDisplay(s.summary)} · {s.summary.requests} {t('settings.usage.reqs')}
              </span>
            )}
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-muted-foreground">
                <th className="text-left font-medium px-3 py-2">{t('settings.usage.model')}</th>
                <th className="text-right font-medium px-3 py-2">{t('settings.usage.reqs')}</th>
                <th className="text-right font-medium px-3 py-2">{t('settings.usage.usage')}</th>
              </tr>
            </thead>
            <tbody>
              {s.models.map((m) => (
                <tr key={m.key} className="border-t">
                  <td className="px-3 py-2 font-mono text-xs">{m.key}</td>
                  <td className="px-3 py-2 text-right">{m.requests}</td>
                  <td className="px-3 py-2 text-right">{usageDisplay(m)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
