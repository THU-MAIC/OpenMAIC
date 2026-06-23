'use client';

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import { Loader2, RefreshCw, Coins } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/hooks/use-i18n';

echarts.use([LineChart, GridComponent, TooltipComponent, LegendComponent, SVGRenderer]);

interface Bucket {
  key: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  totalCostUsd: number;
}

interface UsageResponse {
  totals: Bucket;
  byModel: Bucket[];
  byDay: Bucket[];
  bySource: Bucket[];
  costIncomplete: boolean;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtCost(n: number): string {
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

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
      // ignore — dashboard is best-effort
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const byDay = useMemo(() => data?.byDay ?? [], [data]);

  // Render the daily tokens/cost trend chart.
  useEffect(() => {
    if (!chartRef.current) return;
    if (!chartInstance.current) {
      chartInstance.current = echarts.init(chartRef.current, undefined, { renderer: 'svg' });
    }
    const chart = chartInstance.current;
    const days = byDay.map((b) => b.key);
    chart.setOption({
      tooltip: { trigger: 'axis' },
      legend: { data: [t('settings.usage.tokens'), t('settings.usage.cost')], bottom: 0 },
      grid: { left: 50, right: 50, top: 20, bottom: 40 },
      xAxis: { type: 'category', data: days },
      yAxis: [
        { type: 'value', name: t('settings.usage.tokens') },
        { type: 'value', name: t('settings.usage.cost'), position: 'right' },
      ],
      series: [
        {
          name: t('settings.usage.tokens'),
          type: 'line',
          smooth: true,
          data: byDay.map((b) => b.totalTokens),
        },
        {
          name: t('settings.usage.cost'),
          type: 'line',
          smooth: true,
          yAxisIndex: 1,
          data: byDay.map((b) => Number(b.totalCostUsd.toFixed(4))),
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

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Coins className="h-4 w-4 text-muted-foreground" />
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
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-lg border p-3">
          <div className="text-xs text-muted-foreground">{t('settings.usage.totalRequests')}</div>
          <div className="text-lg font-semibold">{totals?.requests ?? 0}</div>
        </div>
        <div className="rounded-lg border p-3">
          <div className="text-xs text-muted-foreground">{t('settings.usage.totalTokens')}</div>
          <div className="text-lg font-semibold">{fmtTokens(totals?.totalTokens ?? 0)}</div>
        </div>
        <div className="rounded-lg border p-3">
          <div className="text-xs text-muted-foreground">{t('settings.usage.totalCost')}</div>
          <div className="text-lg font-semibold">
            {fmtCost(totals?.totalCostUsd ?? 0)}
            {data?.costIncomplete && <span className="text-amber-500"> *</span>}
          </div>
        </div>
      </div>
      {data?.costIncomplete && (
        <p className="text-xs text-amber-600 -mt-3">{t('settings.usage.costIncomplete')}</p>
      )}

      {/* Daily trend */}
      <div className="rounded-lg border p-3">
        <div className="text-xs text-muted-foreground mb-2">{t('settings.usage.dailyTrend')}</div>
        {byDay.length > 0 ? (
          <div ref={chartRef} style={{ width: '100%', height: 240 }} />
        ) : (
          <div className="h-[120px] flex items-center justify-center text-sm text-muted-foreground">
            {t('settings.usage.empty')}
          </div>
        )}
      </div>

      {/* By model table */}
      {(data?.byModel.length ?? 0) > 0 && (
        <div className="rounded-lg border overflow-hidden">
          <div className="text-xs text-muted-foreground px-3 py-2 border-b bg-muted/30">
            {t('settings.usage.byModel')}
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-muted-foreground">
                <th className="text-left font-medium px-3 py-2">{t('settings.usage.model')}</th>
                <th className="text-right font-medium px-3 py-2">{t('settings.usage.reqs')}</th>
                <th className="text-right font-medium px-3 py-2">{t('settings.usage.tokens')}</th>
                <th className="text-right font-medium px-3 py-2">{t('settings.usage.cost')}</th>
              </tr>
            </thead>
            <tbody>
              {data!.byModel.map((m) => (
                <tr key={m.key} className="border-t">
                  <td className="px-3 py-2 font-mono text-xs">{m.key}</td>
                  <td className="px-3 py-2 text-right">{m.requests}</td>
                  <td className="px-3 py-2 text-right">{fmtTokens(m.totalTokens)}</td>
                  <td className="px-3 py-2 text-right">{fmtCost(m.totalCostUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
