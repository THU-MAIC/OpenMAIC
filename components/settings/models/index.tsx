'use client';

import { useState } from 'react';
import { AlertCircle, Loader2, Lock, RefreshCw, Server } from 'lucide-react';

import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/hooks/use-i18n';
import { modelSettingsClient, type ModelSettingsClient } from '@/lib/model-settings/client';
import { resumeFirstRun, type OffMemory } from '@/lib/model-settings/edit';
import { useModelSettings } from '@/lib/model-settings/use-model-settings';
import { cn } from '@/lib/utils';

import { SetupNotice } from './setup-notice';
import type { SetupOutcome } from './first-run-setup';
import { ModelMap } from './model-map';
import { ProvidersPanel } from './providers-panel';
import { MS } from './slot-meta';

type Tab = 'map' | 'providers';

/**
 * The "Models" settings section: the course model map (which model each part
 * of the product uses, edited in place) and the providers those models come
 * from. Everything is read from and written to the server
 * (`/api/model-config`); nothing is kept in the browser.
 */
export function ModelSettingsPanel({
  onOpenLegacy,
  client,
}: {
  onOpenLegacy?: () => void;
  /** The settings client; the page's shared one unless a test passes its own. */
  client?: ModelSettingsClient;
}) {
  const { t } = useI18n();
  const { state, apply, reload } = useModelSettings(client);
  const [tab, setTab] = useState<Tab>('map');
  const [offMemory] = useState<OffMemory>(() => new Map());
  // A first-run setup that added its provider but could not assign it stays
  // on screen, whatever reloads meanwhile, until it is resolved or dismissed.
  const [setupNotice, setSetupNotice] = useState<SetupOutcome | null>(null);
  const view = state.view;

  const onSetupOutcome = (outcome: SetupOutcome) => {
    if (outcome.result.status === 'done') {
      setSetupNotice(null);
      toast.success(t(`${MS}.setup.done`, { name: outcome.preset.name }));
    } else {
      setSetupNotice(outcome);
    }
  };

  if (state.phase === 'unavailable') {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-12 text-center">
        <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Server className="size-5" aria-hidden="true" />
        </span>
        <h3 className="text-sm font-semibold">{t(`${MS}.unavailable.title`)}</h3>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t(`${MS}.unavailable.body`)}
        </p>
        {onOpenLegacy && (
          <Button variant="outline" size="sm" onClick={onOpenLegacy}>
            {t(`${MS}.unavailable.openLegacy`)}
          </Button>
        )}
      </div>
    );
  }

  if (!view) {
    if (state.phase === 'error') {
      return (
        <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-12 text-center">
          <AlertCircle className="size-5 text-destructive" aria-hidden="true" />
          <p className="text-xs text-muted-foreground">
            {t(`${MS}.loadFailed`, { message: state.error ?? '' })}
          </p>
          <Button variant="outline" size="sm" onClick={() => void reload()}>
            <RefreshCw className="size-3.5" aria-hidden="true" />
            {t(`${MS}.retry`)}
          </Button>
        </div>
      );
    }
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-xs text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        {t(`${MS}.loading`)}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div role="tablist" aria-label={t(`${MS}.title`)} className="flex gap-1">
          {(['map', 'providers'] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={cn(
                'rounded-full px-3 py-1.5 text-xs transition-colors',
                tab === id
                  ? 'bg-primary/10 font-medium text-primary ring-1 ring-inset ring-primary/15'
                  : 'text-muted-foreground hover:bg-muted',
              )}
            >
              {t(`${MS}.tabs.${id}`)}
            </button>
          ))}
        </div>
        {tab === 'map' && (
          <div
            className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground"
            aria-label={t(`${MS}.legend.label`)}
          >
            <span className="inline-flex items-center gap-1.5">
              <span className="w-5 border-t-[1.5px] border-primary/50" aria-hidden="true" />
              {t(`${MS}.legend.follows`)}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                className="w-5 border-t-[1.5px] border-dashed border-muted-foreground/50"
                aria-hidden="true"
              />
              {t(`${MS}.legend.own`)}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Lock className="size-3" aria-hidden="true" />
              {t(`${MS}.legend.locked`)}
            </span>
          </div>
        )}
      </div>

      {state.phase === 'error' && (
        <p
          role="alert"
          className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <AlertCircle className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            {t(`${MS}.loadFailed`, { message: state.error ?? '' })}
          </span>
          <Button variant="ghost" size="xs" onClick={() => void reload()}>
            {t(`${MS}.retry`)}
          </Button>
        </p>
      )}

      {setupNotice && setupNotice.result.status === 'partial' && (
        <SetupNotice
          outcome={setupNotice}
          onRetry={async () => {
            const settings = client ?? modelSettingsClient;
            let current = settings.getState().view ?? view;
            if (
              setupNotice.result.status === 'partial' &&
              setupNotice.result.reason === 'unconfirmed-add'
            ) {
              // Read the settings again first; while that fails, nothing is known yet.
              const reloaded = await settings.load();
              if (reloaded.phase !== 'ready' || !reloaded.view) return;
              current = reloaded.view;
            }
            onSetupOutcome({
              preset: setupNotice.preset,
              result: await resumeFirstRun(
                apply,
                current,
                setupNotice.preset,
                setupNotice.result.providerId,
              ),
            });
          }}
          onProviders={() => setTab('providers')}
          onDismiss={() => setSetupNotice(null)}
          t={t}
        />
      )}

      {tab === 'map' ? (
        <ModelMap
          view={view}
          apply={apply}
          t={t}
          onManageProviders={() => setTab('providers')}
          offMemory={offMemory}
          onSetupOutcome={onSetupOutcome}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="max-w-3xl">
            <ProvidersPanel view={view} apply={apply} t={t} />
          </div>
        </div>
      )}
    </div>
  );
}
