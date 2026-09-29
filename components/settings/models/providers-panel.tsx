'use client';

import { useRef, useState } from 'react';
import { AlertCircle, KeyRound, Loader2, Lock, Pencil, Plus, Trash2 } from 'lucide-react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { SlotCapability } from '@/lib/config/model-slots';
import type {
  ApplyResult,
  ModelSettingsChange,
  ModelSettingsView,
  ProviderView,
} from '@/lib/model-settings/client';
import {
  draftFor,
  draftProblem,
  emptyDraft,
  newProviderId,
  presetOf,
  providerChange,
  providerLabel,
  type ProviderDraft,
} from '@/lib/model-settings/edit';

import { PresetSelect, ProviderFields } from './provider-form';
import { CAPABILITY_ICONS, MS, applyErrorText } from './slot-meta';

type T = (key: string, options?: Record<string, unknown>) => string;
type Apply = (change: ModelSettingsChange) => Promise<ApplyResult>;

function problemMessage(problem: ReturnType<typeof draftProblem>, t: T): string | undefined {
  if (problem === 'baseUrl') return t(`${MS}.providers.needsBaseUrl`);
  if (problem === 'models') return t(`${MS}.providers.needsModels`);
  return undefined;
}

function KeyState({ provider, t }: { provider: ProviderView; t: T }) {
  const key = provider.key;
  if (!key) return null;
  if (key.unreadable) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400">
        <AlertCircle className="size-3" aria-hidden="true" />
        {t(`${MS}.providers.keyUnreadable`)}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
      <KeyRound className="size-3" aria-hidden="true" />
      {key.set
        ? key.mask
          ? t(`${MS}.providers.keySet`, { mask: key.mask })
          : t(`${MS}.providers.keySetNoMask`)
        : t(`${MS}.providers.noKey`)}
    </span>
  );
}

/** The form that adds a provider, or edits a workspace one. */
function ProviderEditor({
  view,
  existing,
  apply,
  onDone,
  t,
}: {
  view: ModelSettingsView;
  existing?: ProviderView;
  apply: Apply;
  onDone: () => void;
  t: T;
}) {
  const [draft, setDraft] = useState<ProviderDraft>(() =>
    existing ? draftFor(existing) : emptyDraft(''),
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const preset = view.presets.find((entry) => entry.id === draft.preset);
  const problem = draftProblem(preset, draft);
  const hint = draft.preset ? problemMessage(problem, t) : undefined;

  // A new provider's id, kept across tries: an add whose answer was lost may
  // have saved it, and a retry must update that provider, not add a second.
  const attempt = useRef<{ id: string; preset: string; unconfirmed: boolean } | null>(null);

  const newId = (presetId: string) => {
    const previous = attempt.current;
    const taken = view.providers.some((provider) => provider.id === previous?.id);
    return previous && previous.preset === presetId && (previous.unconfirmed || !taken)
      ? previous.id
      : newProviderId(view, presetId);
  };

  const save = async () => {
    if (!preset || problem) return;
    setSaving(true);
    setMessage(null);
    try {
      const id = existing?.id ?? newId(preset.id);
      const result = await apply(providerChange(id, draft, preset, existing));
      if (result.ok) return onDone();
      if (!existing) {
        attempt.current = { id, preset: preset.id, unconfirmed: result.reason === 'unconfirmed' };
        // The reloaded view has it: the add went through after all.
        if (result.view?.providers.some((provider) => provider.id === id)) return onDone();
      }
      setMessage(applyErrorText(result, t));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-3">
      {!existing && (
        <PresetSelect
          presets={view.presets}
          value={draft.preset}
          onChange={(presetId) => setDraft({ ...draft, preset: presetId })}
          t={t}
        />
      )}
      {preset && (
        <ProviderFields
          preset={preset}
          draft={draft}
          onChange={setDraft}
          existing={existing}
          t={t}
        />
      )}
      {(message || hint) && (
        <p
          role={message ? 'alert' : undefined}
          className={
            message
              ? 'flex items-start gap-1.5 rounded-md bg-destructive/10 px-2.5 py-2 text-[11px] leading-relaxed text-destructive'
              : 'text-[11px] text-muted-foreground'
          }
        >
          {message && <AlertCircle className="mt-px size-3.5 shrink-0" aria-hidden="true" />}
          <span className="min-w-0 break-words">{message ?? hint}</span>
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDone}>
          {t(`${MS}.actions.cancel`)}
        </Button>
        <Button size="sm" onClick={save} disabled={!preset || !!problem || saving}>
          {saving && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
          {existing ? t(`${MS}.actions.save`) : t(`${MS}.providers.add`)}
        </Button>
      </div>
    </div>
  );
}

/**
 * The providers the slots can use: the server's (read-only) and the
 * workspace's own, which can be added, edited and removed as the server's
 * policy allows.
 */
export function ProvidersPanel({
  view,
  apply,
  t,
}: {
  view: ModelSettingsView;
  apply: Apply;
  t: T;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<ProviderView | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const canAdd = view.policy.allowWorkspaceProviders && view.presets.length > 0;

  const remove = async () => {
    if (!removing) return;
    try {
      const result = await apply({ kind: 'remove-provider', id: removing.id });
      if (!result.ok) setRemoveError(applyErrorText(result, t));
    } finally {
      setRemoving(null);
    }
  };

  return (
    <section className="space-y-3" aria-labelledby="model-settings-providers">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h3 id="model-settings-providers" className="text-sm font-semibold">
            {t(`${MS}.providers.title`)}
          </h3>
          <p className="text-xs text-muted-foreground">{t(`${MS}.providers.hint`)}</p>
        </div>
        {canAdd && !adding && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setAdding(true);
              setEditing(null);
            }}
          >
            <Plus className="size-3.5" aria-hidden="true" />
            {t(`${MS}.providers.add`)}
          </Button>
        )}
      </div>

      {removeError && (
        <p
          role="alert"
          className="flex items-start gap-1.5 rounded-md bg-destructive/10 px-2.5 py-2 text-[11px] text-destructive"
        >
          <AlertCircle className="mt-px size-3.5 shrink-0" aria-hidden="true" />
          {removeError}
        </p>
      )}

      <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60">
        {adding && (
          <div className="bg-muted/20 p-3.5">
            <p className="mb-3 text-xs font-medium">{t(`${MS}.providers.addTitle`)}</p>
            <ProviderEditor view={view} apply={apply} onDone={() => setAdding(false)} t={t} />
          </div>
        )}

        {view.providers.length === 0 && !adding && (
          <p className="px-3.5 py-6 text-center text-xs text-muted-foreground">
            {t(`${MS}.providers.empty`)}
          </p>
        )}

        {view.providers.map((provider) => {
          const preset = presetOf(view, provider);
          const label = providerLabel(view, provider.id);
          const server = provider.source === 'deployment';
          const editable = !server && view.policy.allowWorkspaceProviders && !!preset;
          return (
            <div key={provider.id} className="px-3.5 py-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <div className="min-w-0 flex-1 basis-40">
                  <p className="flex items-center gap-2 text-sm font-medium leading-5">
                    <span className="truncate">{label}</span>
                    {server && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge
                            variant="secondary"
                            className="shrink-0 gap-1 text-[10px]"
                            tabIndex={0}
                          >
                            <Lock className="size-2.5" aria-hidden="true" />
                            {t(`${MS}.providers.server`)}
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent className="text-xs">
                          {t(`${MS}.providers.serverHint`)}
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </p>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                    {label !== provider.id || (preset && preset.name !== label) ? (
                      <span className="truncate text-[11px] text-muted-foreground">
                        {label !== provider.id ? provider.id : preset?.name}
                      </span>
                    ) : null}
                    <span className="flex items-center gap-1 text-muted-foreground/80">
                      {(Object.keys(provider.capabilities) as SlotCapability[]).map(
                        (capability) => {
                          const Icon = CAPABILITY_ICONS[capability];
                          return (
                            <Icon
                              key={capability}
                              className="size-3"
                              role="img"
                              aria-label={t(`${MS}.capabilities.${capability}`)}
                            />
                          );
                        },
                      )}
                    </span>
                    <KeyState provider={provider} t={t} />
                  </div>
                </div>
                {!server && editing !== provider.id && (
                  <div className="flex shrink-0 items-center gap-1">
                    {editable && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t(`${MS}.providers.edit`, { name: label })}
                        onClick={() => {
                          setEditing(provider.id);
                          setAdding(false);
                        }}
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground hover:text-destructive"
                      aria-label={t(`${MS}.providers.remove`, { name: label })}
                      onClick={() => {
                        setRemoveError(null);
                        setRemoving(provider);
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                )}
              </div>
              {editing === provider.id && (
                <div className="mt-3">
                  <ProviderEditor
                    view={view}
                    existing={provider}
                    apply={apply}
                    onDone={() => setEditing(null)}
                    t={t}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      <AlertDialog open={!!removing} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(`${MS}.providers.removeTitle`, {
                name: removing ? providerLabel(view, removing.id) : '',
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t(`${MS}.providers.removeBody`)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t(`${MS}.actions.cancel`)}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={remove}>
              {t(`${MS}.providers.removeConfirm`)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
