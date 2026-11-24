'use client';

// The quota a connected token plan's vendor reports for the plan's saved key,
// asked once per workspace provider while the page is open and shared by the
// plan list (a one-line summary) and the selected plan (a card of meters or
// balances). A vendor without a query, or one that does not answer, reads
// "unavailable": the page cannot tell which.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, Info, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import type { PlanQuota, PlanQuotaWindow } from '@/lib/model-settings/plan-status';

const tp = 'settings.tokenPlan';

const UNAVAILABLE: PlanQuota = { status: 'unavailable' };

/** Capabilities a plan may meter on their own. */
const CATEGORY_LABEL_KEYS: Record<string, string> = {
  video: `${tp}.capVideo`,
};

export interface QuotaEntry {
  quota?: PlanQuota;
  loading: boolean;
  /** When the answer shown was received. */
  at?: number;
}

/**
 * The quota of each provider id, asked when an id first appears and again
 * for one id on refresh. Replacing a key discards that connection's old answer.
 */
export function usePlanQuotas(providerIds: readonly string[]) {
  const [entries, setEntries] = useState<Record<string, QuotaEntry>>({});
  const visible = useRef(new Set<string>());
  const latest = useRef(new Map<string, number>());
  const key = providerIds.join('\n');

  /** Ask once; state changes only when the answer arrives. */
  const ask = useCallback(async (id: string) => {
    const request = (latest.current.get(id) ?? 0) + 1;
    latest.current.set(id, request);
    const res = await fetch(
      `/api/model-config/plan-status?provider=${encodeURIComponent(id)}`,
    ).catch(() => null);
    const json = res?.ok
      ? ((await res.json().catch(() => null)) as { quota?: PlanQuota } | null)
      : null;
    const quota = json?.quota ?? UNAVAILABLE;
    if (latest.current.get(id) !== request) return;
    setEntries((current) => ({
      ...current,
      [id]: { quota, loading: false, at: Date.now() },
    }));
  }, []);

  useEffect(() => {
    const ids = new Set(key ? key.split('\n') : []);
    const removed = [...visible.current].filter((id) => !ids.has(id));
    if (removed.length) {
      for (const id of removed) latest.current.set(id, (latest.current.get(id) ?? 0) + 1);
      setEntries((current) => {
        const next = { ...current };
        for (const id of removed) delete next[id];
        return next;
      });
    }
    for (const id of ids) {
      if (!visible.current.has(id)) void ask(id);
    }
    visible.current = ids;
  }, [key, ask]);

  const refresh = (id: string, keyChanged = false) => {
    setEntries((current) => ({
      ...current,
      [id]: keyChanged ? { loading: true } : { ...current[id], loading: true },
    }));
    void ask(id);
  };
  return { entries, refresh };
}

/** The lowest share left over a plan's windows, with the category it belongs to. */
function lowestWindow(quota: Extract<PlanQuota, { status: 'available' }>) {
  let lowest: PlanQuotaWindow | undefined;
  for (const window of quota.windows) {
    if (window.remainingPercent === undefined) continue;
    if (!lowest || window.remainingPercent < lowest.remainingPercent!) lowest = window;
  }
  return lowest;
}

/** The plan list's one-line summary: what is left, the balance, or that it cannot be looked up. */
export function QuotaSummary({ entry }: { entry: QuotaEntry | undefined }) {
  const { t } = useI18n();
  if (!entry?.quota) return <span className="text-muted-foreground">…</span>;
  const quota = entry.quota;
  if (quota.status === 'unavailable') {
    return <span className="text-muted-foreground">{t(`${tp}.quotaNa`)}</span>;
  }
  const lowest = lowestWindow(quota);
  if (lowest) {
    const percent = Math.round(lowest.remainingPercent!);
    const key = lowest.category ? CATEGORY_LABEL_KEYS[lowest.category] : undefined;
    const left = t(`${tp}.quotaRemaining`, { percent });
    return (
      <span className={cn(percent === 0 && 'text-destructive')}>
        {lowest.category ? `${key ? t(key) : lowest.category} ${left}` : left}
      </span>
    );
  }
  if (quota.windows.some((window) => window.unlimited)) return <>{t(`${tp}.quotaUnlimited`)}</>;
  const balance = quota.balances[0];
  if (balance) return <span className="font-mono">{`${balance.amount} ${balance.currency}`}</span>;
  return <span className="text-muted-foreground">{t(`${tp}.quotaNa`)}</span>;
}

/**
 * The selected plan's quota: a meter per window with its reset time, the
 * balance per currency, or a note that it cannot be looked up with the
 * vendor's own page to check.
 */
export function PlanQuotaCard({
  name,
  entry,
  onRefresh,
  accountUrl,
}: {
  name: string;
  entry: QuotaEntry | undefined;
  onRefresh: () => void;
  /** The vendor page to check the balance or top up (none: no link). */
  accountUrl?: string;
}) {
  const { t, locale } = useI18n();
  const quota = entry?.quota;
  const balanceOnly =
    quota?.status === 'available' && quota.windows.length === 0 && quota.balances.length > 0;

  const time = (iso: string | undefined) => {
    const at = iso ? new Date(iso) : null;
    return at && !Number.isNaN(at.getTime())
      ? at.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })
      : null;
  };

  const windowTitle = (window: PlanQuotaWindow) => {
    const period =
      window.period === 'hours'
        ? t(`${tp}.windowHours`, { n: window.hours ?? '?' })
        : t(window.period === 'week' ? `${tp}.windowWeek` : `${tp}.windowMonth`);
    if (!window.category) return period;
    const key = CATEGORY_LABEL_KEYS[window.category];
    return `${key ? t(key) : window.category} · ${period}`;
  };

  const accountLink = (label: string) =>
    accountUrl && (
      <a
        href={accountUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex shrink-0 items-center gap-1 rounded-md border bg-background px-2.5 py-1 text-xs font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
      >
        {label}
        <ExternalLink className="size-3" aria-hidden="true" />
      </a>
    );

  return (
    <section className="space-y-3 rounded-xl border bg-muted/20 p-4">
      <div className="flex items-center justify-between gap-2">
        <h5 className="text-sm font-medium">
          {t(balanceOnly ? `${tp}.balanceTitle` : `${tp}.quotaTitle`)}
        </h5>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          {entry?.at && !entry.loading && (
            <span>
              {t(`${tp}.quotaUpdatedAt`, {
                time: new Date(entry.at).toLocaleTimeString(locale, { timeStyle: 'short' }),
              })}
            </span>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={onRefresh}
            disabled={!!entry?.loading}
            aria-label={t('settings.usage.refresh')}
          >
            {entry?.loading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
          </Button>
        </div>
      </div>

      {!quota ? (
        <div className="h-16 animate-pulse rounded-lg bg-muted/60 motion-reduce:animate-none" />
      ) : quota.status === 'unavailable' ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-background p-3">
          <div className="flex min-w-0 gap-2">
            <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0 text-xs leading-5">
              <p className="font-medium">{t(`${tp}.quotaUnavailableTitle`, { name })}</p>
              <p className="text-muted-foreground">{t(`${tp}.quotaUnavailableBody`, { name })}</p>
            </div>
          </div>
          {accountLink(t(`${tp}.checkBalance`))}
        </div>
      ) : (
        <>
          {quota.windows.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2">
              {quota.windows.map((window, index) => {
                const percent =
                  window.remainingPercent === undefined
                    ? undefined
                    : Math.round(window.remainingPercent);
                const resets = time(window.resetsAt);
                return (
                  <div key={index} className="space-y-2 rounded-lg border bg-background p-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xs text-muted-foreground">{windowTitle(window)}</span>
                      <span className="text-right">
                        {window.unlimited ? (
                          <span className="text-sm font-semibold">{t(`${tp}.quotaUnlimited`)}</span>
                        ) : percent === 0 ? (
                          <span className="text-sm font-semibold text-destructive">
                            {t(`${tp}.quotaExhausted`)}
                          </span>
                        ) : percent !== undefined ? (
                          <span className="text-lg font-semibold tabular-nums">
                            {percent}%
                            <span className="ml-1 text-xs font-normal text-muted-foreground">
                              {t(`${tp}.quotaLeft`)}
                            </span>
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            {t(`${tp}.quotaUnknown`)}
                          </span>
                        )}
                      </span>
                    </div>
                    {!window.unlimited && percent !== undefined && (
                      <div
                        className="h-1.5 overflow-hidden rounded-full bg-muted"
                        role="meter"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.min(100, percent)}
                        aria-label={windowTitle(window)}
                      >
                        <div
                          className={cn(
                            'h-full rounded-full',
                            percent === 0 ? 'bg-destructive' : 'bg-primary',
                          )}
                          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
                        />
                      </div>
                    )}
                    <div className="flex flex-wrap justify-between gap-x-2 text-[11px] leading-4 text-muted-foreground">
                      <span>
                        {resets
                          ? t(`${tp}.quotaResetsAt`, { time: resets })
                          : t(`${tp}.quotaResetUnknown`)}
                      </span>
                      {window.used !== undefined && window.total !== undefined && (
                        <span className="tabular-nums">
                          {t(`${tp}.quotaCalls`, { used: window.used, total: window.total })}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {quota.balances.length > 0 && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                {quota.balances.map((balance) => (
                  <div
                    key={balance.currency}
                    className="flex items-baseline justify-between gap-2 rounded-lg border bg-background p-3"
                  >
                    <span className="text-xs text-muted-foreground">
                      {t(`${tp}.balanceOf`, { currency: balance.currency })}
                    </span>
                    <span className="font-mono text-lg font-semibold tabular-nums">
                      {balance.amount}
                    </span>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                {quota.windows.length === 0 && (
                  <p className="text-xs text-muted-foreground">{t(`${tp}.quotaNoReset`)}</p>
                )}
                {accountLink(t(`${tp}.openPlatform`))}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
