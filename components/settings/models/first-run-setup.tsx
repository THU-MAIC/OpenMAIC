'use client';

import { useId, useMemo, useState } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import type {
  ApplyResult,
  ModelSettingsChange,
  ModelSettingsView,
} from '@/lib/model-settings/client';
import {
  draftProblem,
  emptyDraft,
  runFirstRunSetup,
  type ProviderDraft,
} from '@/lib/model-settings/edit';

import { PresetSelect, ProviderFields } from './provider-form';
import { MS } from './slot-meta';

type T = (key: string, options?: Record<string, unknown>) => string;

/**
 * The first-run setup, opened from the default model's card while no language
 * model is configured: pick a service and give its key; it is added and its
 * recommended models fill every slot that is still empty.
 */
export function FirstRunSetup({
  view,
  apply,
  onDone,
  t,
}: {
  view: ModelSettingsView;
  apply: (change: ModelSettingsChange) => Promise<ApplyResult>;
  onDone: (serviceName: string) => void;
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
    const result = await runFirstRunSetup(apply, view, preset, draft);
    setWorking(false);
    if (result.status === 'done') onDone(preset.name);
    else if (result.status === 'partial') {
      setMessage(
        result.message
          ? t(`${MS}.setup.partial`, { message: result.message })
          : t(`${MS}.setup.noModel`),
      );
    } else {
      setMessage(result.reason === 'conflict' ? t(`${MS}.picker.conflict`) : result.message);
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
