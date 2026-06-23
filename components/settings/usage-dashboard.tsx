'use client';

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import { Loader2, RefreshCw, BarChart3 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/hooks/use-i18n';

echarts.use([LineChart, GridComponent, TooltipComponent, LegendComponent, SVGRenderer]);

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

export function UsageDashboard() {
  const { t } = useI18n();
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

  // Daily LLM-token trend (single axis, no cost).
  useEffect(() => {
    if (!chartRef.current) return;
    if (!chartInstance.current) {
      chartInstance.current = echarts.init(chartRef.current, undefined, { renderer: 'svg' });
    }
    const chart = chartInstance.current;
    chart.setOption({
      tooltip: { trigger: 'axis' },
      grid: { left: 55, right: 20, top: 20, bottom: 40 },
      xAxis: { type: 'category', data: byDay.map((b) => b.key) },
      yAxis: { type: 'value', name: t('settings.usage.tokens') },
      series: [
        {
          name: t('settings.usage.tokens'),
          type: 'line',
          smooth: true,
          areaStyle: {},
          data: byDay.map((b) => b.totalTokens),
        },
      ],
    });
    chart.resize();
  }, [byDay, t]);

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

  /** Usage figure for a model/kind row, with its unit label. */
  const usageDisplay = (b: Bucket): string => {
    if (b.kind === 'llm') return `${fmtNum(b.totalTokens)} ${t('settings.usage.unitToken')}`;
    return `${fmtNum(b.quantity)} ${t(UNIT_LABEL_KEY[b.unit])}`;
  };

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

      {/* Totals */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border p-3">
          <div className="text-xs text-muted-foreground">{t('settings.usage.totalRequests')}</div>
          <div className="text-lg font-semibold">{totals?.requests ?? 0}</div>
        </div>
        <div className="rounded-lg border p-3">
          <div className="text-xs text-muted-foreground">{t('settings.usage.totalTokens')}</div>
          <div className="text-lg font-semibold">{fmtNum(totals?.llmTokens ?? 0)}</div>
        </div>
      </div>

      {/* By modality */}
      {(data?.byKind.length ?? 0) > 0 && (
        <div className="flex flex-wrap gap-2">
          {data!.byKind.map((b) => (
            <div key={b.kind} className="rounded-lg border px-3 py-2 text-sm">
              <span className="text-muted-foreground">{t(KIND_LABEL_KEY[b.kind])}</span>
              <span className="ml-2 font-medium">{usageDisplay(b)}</span>
              <span className="ml-1 text-xs text-muted-foreground">({b.requests})</span>
            </div>
          ))}
        </div>
      )}

      {/* Daily LLM-token trend */}
      <div className="rounded-lg border p-3">
        <div className="text-xs text-muted-foreground mb-2">{t('settings.usage.dailyTrend')}</div>
        {byDay.length > 0 ? (
          <div ref={chartRef} style={{ width: '100%', height: 220 }} />
        ) : (
          <div className="h-[120px] flex items-center justify-center text-sm text-muted-foreground">
            {t('settings.usage.empty')}
          </div>
        )}
      </div>

      {/* By model */}
      {(data?.byModel.length ?? 0) > 0 && (
        <div className="rounded-lg border overflow-hidden">
          <div className="text-xs text-muted-foreground px-3 py-2 border-b bg-muted/30">
            {t('settings.usage.byModel')}
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-muted-foreground">
                <th className="text-left font-medium px-3 py-2">{t('settings.usage.model')}</th>
                <th className="text-left font-medium px-3 py-2">{t('settings.usage.type')}</th>
                <th className="text-right font-medium px-3 py-2">{t('settings.usage.reqs')}</th>
                <th className="text-right font-medium px-3 py-2">{t('settings.usage.usage')}</th>
              </tr>
            </thead>
            <tbody>
              {data!.byModel.map((m) => (
                <tr key={m.key} className="border-t">
                  <td className="px-3 py-2 font-mono text-xs">{m.key}</td>
                  <td className="px-3 py-2">{t(KIND_LABEL_KEY[m.kind])}</td>
                  <td className="px-3 py-2 text-right">{m.requests}</td>
                  <td className="px-3 py-2 text-right">{usageDisplay(m)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
