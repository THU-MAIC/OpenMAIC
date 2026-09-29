'use client';

import { useId, useMemo, useState } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import type {
  ApplyResult,
  ModelSettingsChange,
  ModelSettingsView,
  PresetView,
  ApplyChange,
} from '@/lib/model-settings/client';
import {
  draftProblem,
  emptyDraft,
  runFirstRunSetup,
  type FirstRunResult,
  type ProviderDraft,
} from '@/lib/model-settings/edit';

import { PresetSelect, ProviderFields } from './provider-form';
import { MS, applyErrorText } from './slot-meta';

type T = (key: string, options?: Record<string, unknown>) => string;

/** A first-run setup that added its provider: done, or with the slots still to fill. */
export interface SetupOutcome {
  preset: PresetView;
  result: Exclude<FirstRunResult, { status: 'failed' }>;
}

/**
 * The first-run setup, opened from the default model's card while no language
 * model is configured: pick a service and give its key; it is added and its
 * recommended models fill every slot that is still empty.
 *
 * Once the provider exists the outcome goes to `onOutcome`, which outlives
 * this form (the view reloads, the card may change): a provider added but not
 * assigned must not be forgotten with it. Only a provider that could not be
 * added is reported here, next to the fields to correct.
 */
export function FirstRunSetup({
  view,
  apply,
  onOutcome,
  t,
}: {
  view: ModelSettingsView;
  apply: ApplyChange;
  onOutcome: (outcome: SetupOutcome) => void;
  t: T;
}) {
  const id = useId();
  const presets = useMemo(
    () => view.presets.filter((preset) => preset.capabilities.chat),
    [view.presets],
  );
  const [draft, setDraft] = useState<ProviderDraft>(() => emptyDraft(''));
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const preset = presets.find((entry) => entry.id === draft.preset);
  const problem = draftProblem(preset, draft);

  const connect = async () => {
    if (!preset || problem) return;
    setWorking(true);
    setMessage(null);
    try {
      const result = await runFirstRunSetup(apply, view, preset, draft);
      if (result.status === 'failed') setMessage(applyErrorText(result, t));
      else onOutcome({ preset, result });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setWorking(false);
    }
  };

  return (
    <form
      className="flex flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        void connect();
      }}
    >
      <div className="border-b px-3 pb-2 pt-2.5">
        <p className="text-[13px] font-semibold leading-tight">{t(`${MS}.setup.title`)}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          {t(`${MS}.setup.body`)}
        </p>
      </div>
      <div className="grid gap-3 p-3">
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-preset`} className="text-xs">
            {t(`${MS}.providers.preset`)}
          </Label>
          <PresetSelect
            id={`${id}-preset`}
            presets={presets}
            value={draft.preset}
            onChange={(presetId) => setDraft({ ...draft, preset: presetId })}
            t={t}
          />
        </div>
        {preset && <ProviderFields preset={preset} draft={draft} onChange={setDraft} t={t} />}
        {message && (
          <p
            role="alert"
            className="flex items-start gap-1.5 rounded-md bg-destructive/10 px-2.5 py-2 text-[11px] leading-relaxed text-destructive"
          >
            <AlertCircle className="mt-px size-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 break-words">{message}</span>
          </p>
        )}
      </div>
      <div className="flex justify-end border-t px-3 py-2">
        <Button type="submit" size="sm" disabled={!preset || !!problem || working}>
          {working && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
          {working ? t(`${MS}.setup.connecting`) : t(`${MS}.setup.connect`)}
        </Button>
      </div>
    </form>
  );
}
