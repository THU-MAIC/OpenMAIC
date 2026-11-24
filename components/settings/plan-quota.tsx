'use client';

// The quota a connected token plan's vendor reports for the plan's saved key:
// each metered window with what is left and when it resets, or the balance of
// a pay-as-you-go account. Asked when the plan is shown and on refresh; a
// vendor without a query (or one that does not answer) reads "unavailable".

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { PlanQuota, PlanQuotaWindow } from '@/lib/model-settings/plan-status';

const tp = 'settings.tokenPlan';

const UNAVAILABLE: PlanQuota = { status: 'unavailable' };

/** Capabilities a plan may meter on their own. */
const CATEGORY_LABEL_KEYS: Record<string, string> = {
  video: `${tp}.capVideo`,
};

export function PlanQuota({ providerId }: { providerId: string }) {
  const { t, locale } = useI18n();
  const [quota, setQuota] = useState<PlanQuota | null>(null);
  const [loading, setLoading] = useState(false);
  // Only the latest request's answer is shown: an earlier, slower one is dropped.
  const latest = useRef(0);

  const load = useCallback(async () => {
    setLoading(true);
    const request = ++latest.current;
    try {
      const res = await fetch(
        `/api/model-config/plan-status?provider=${encodeURIComponent(providerId)}`,
      );
      const json = res.ok ? ((await res.json()) as { quota?: PlanQuota }) : null;
      if (request === latest.current) setQuota(json?.quota ?? UNAVAILABLE);
    } catch {
      if (request === latest.current) setQuota(UNAVAILABLE);
    } finally {
      if (request === latest.current) setLoading(false);
    }
  }, [providerId]);

  useEffect(() => {
    void load();
  }, [load]);

  const windowLabel = (window: PlanQuotaWindow): string => {
    const period =
      window.period === 'hours'
        ? t(`${tp}.quotaPeriodHours`, { n: window.hours ?? '?' })
        : t(window.period === 'week' ? `${tp}.quotaPeriodWeek` : `${tp}.quotaPeriodMonth`);
    if (!window.category) return period;
    const key = CATEGORY_LABEL_KEYS[window.category];
    return `${key ? t(key) : window.category} · ${period}`;
  };

  const windowValue = (window: PlanQuotaWindow): string => {
    if (window.unlimited) return t(`${tp}.quotaUnlimited`);
    if (window.remainingPercent === 0) return t(`${tp}.quotaExhausted`);
    const parts: string[] = [];
    if (window.remainingPercent !== undefined) {
      parts.push(t(`${tp}.quotaRemaining`, { percent: Math.round(window.remainingPercent) }));
    }
    if (window.used !== undefined && window.total !== undefined) {
      parts.push(t(`${tp}.quotaCalls`, { used: window.used, total: window.total }));
    }
    return parts.length ? parts.join(' · ') : t(`${tp}.quotaUnknown`);
  };

  const resetText = (window: PlanQuotaWindow): string => {
    const at = window.resetsAt ? new Date(window.resetsAt) : null;
    if (!at || Number.isNaN(at.getTime())) return t(`${tp}.quotaResetUnknown`);
    return t(`${tp}.quotaResetsAt`, {
      time: at.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }),
    });
  };

  return (
    <div className="space-y-2 border-t border-border/60 pt-4">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium">{t(`${tp}.quotaTitle`)}</div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => void load()}
          disabled={loading}
          aria-label={t('settings.usage.refresh')}
        >
          {loading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
        </Button>
      </div>
      {quota === null ? null : quota.status === 'unavailable' ? (
        <p className="text-xs leading-5 text-muted-foreground">{t(`${tp}.quotaUnavailable`)}</p>
      ) : (
        <dl className="space-y-2 text-xs leading-5">
          {quota.windows.map((window, index) => (
            <div key={index} className="flex flex-wrap justify-between gap-x-4">
              <dt className="text-muted-foreground">{windowLabel(window)}</dt>
              <dd className="text-right">
                <span className="font-medium">{windowValue(window)}</span>
                <span className="block text-muted-foreground">{resetText(window)}</span>
              </dd>
            </div>
          ))}
          {quota.balances.map((balance) => (
            <div key={balance.currency} className="flex justify-between gap-4">
              <dt className="text-muted-foreground">{t(`${tp}.quotaBalance`)}</dt>
              <dd className="font-mono">
                {balance.amount} {balance.currency}
              </dd>
            </div>
          ))}
          {quota.balances.length > 0 && quota.windows.length === 0 && (
            <p className="text-muted-foreground">{t(`${tp}.quotaNoReset`)}</p>
          )}
        </dl>
      )}
    </div>
  );
}
