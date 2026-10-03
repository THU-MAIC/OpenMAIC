'use client';

/**
 * Shared pieces of the settings panels that edit the workspace's model
 * configuration on the server (`/api/model-config`): the loading and
 * unavailable states, the notices for what only the server configures, the
 * write-only API key field, and saving a provider from a service panel.
 */
import { useState, type ReactNode } from 'react';
import { AlertCircle, Eye, EyeOff, Loader2, RefreshCw, Server } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { SlotCapability } from '@/lib/config/model-slots';
import { useI18n } from '@/lib/hooks/use-i18n';
import type {
  ApplyChange,
  ApplyResult,
  ModelSettingsChange,
  ModelSettingsClient,
  ModelSettingsView,
  ProviderView,
  SlotView,
} from '@/lib/model-settings/client';
import { findSlot } from '@/lib/model-settings/client';
import { useModelSettings } from '@/lib/model-settings/use-model-settings';
import {
  assignmentsForNewProvider,
  ROOT_SLOT,
  type ServiceEntry,
} from '@/lib/model-settings/services';
import { cn } from '@/lib/utils';

export type T = (key: string, options?: Record<string, unknown>) => string;

export const SC = 'settings.serverConfig';

/** Why a change did not go through, in the user's language where it is ours to say. */
export function applyErrorText(result: { reason: string; message: string }, t: T): string {
  if (result.reason === 'conflict') return t(`${SC}.conflict`);
  if (result.reason === 'locked') return t(`${SC}.lockedNow`);
  if (result.reason === 'unconfirmed') return t(`${SC}.unconfirmed`);
  return result.message;
}

/** Report a change that did not go through. */
export function reportApply(
  result: ApplyResult,
  t: T,
): result is Extract<ApplyResult, { ok: true }> {
  if (!result.ok) toast.error(applyErrorText(result, t));
  return result.ok;
}

/**
 * The workspace's model settings for a section: shows loading, an error with
 * a retry, or that the server keeps none, and otherwise renders the section
 * with the view and the way to change it.
 */
export function ServerSettingsGate({
  client,
  children,
}: {
  client?: ModelSettingsClient;
  children: (view: ModelSettingsView, apply: ApplyChange) => ReactNode;
}) {
  const { t } = useI18n();
  const { state, apply, reload } = useModelSettings(client);
  const view = state.view;

  if (state.phase === 'unavailable') {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-12 text-center">
        <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Server className="size-5" aria-hidden="true" />
        </span>
        <h3 className="text-sm font-semibold">{t(`${SC}.unavailableTitle`)}</h3>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t(`${SC}.unavailableBody`)}
        </p>
      </div>
    );
  }
  if (!view) {
    if (state.phase === 'error') {
      return (
        <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-12 text-center">
          <AlertCircle className="size-5 text-destructive" aria-hidden="true" />
          <p className="text-xs text-muted-foreground">
            {t(`${SC}.loadFailed`, { message: state.error ?? '' })}
          </p>
          <Button variant="outline" size="sm" onClick={() => void reload()}>
            <RefreshCw className="size-3.5" aria-hidden="true" />
            {t(`${SC}.retry`)}
          </Button>
        </div>
      );
    }
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-xs text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        {t(`${SC}.loading`)}
      </div>
    );
  }
  return <>{children(view, apply)}</>;
}

/** The notice of a service the server configures: nothing about it can be changed here. */
export function ServerConfiguredNotice() {
  const { t } = useI18n();
  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-700 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-300">
      {t('settings.serverConfiguredNotice')}
    </div>
  );
}

/** Why a service cannot be set up here: only the server's configuration can. */
export function ServerOnlyNotice({ noUserKeys }: { noUserKeys?: boolean }) {
  const { t } = useI18n();
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
      {t(noUserKeys ? `${SC}.serverOnlyPolicy` : `${SC}.serverOnly`)}
    </div>
  );
}

/** Why an endpoint field is not offered: only the server may point this service elsewhere. */
export function EndpointServerOnlyHint() {
  const { t } = useI18n();
  return <p className="text-xs text-muted-foreground">{t(`${SC}.endpointServerOnly`)}</p>;
}

/**
 * A write-only API key: the stored key is never shown, only its mask. Typing
 * a key and leaving the field (or pressing Enter) saves it; "Remove key"
 * removes the stored one.
 */
export function ApiKeyField({
  provider,
  onSave,
  onRemove,
  disabled,
  placeholder,
  name,
  inputClassName,
  children,
}: {
  provider?: ProviderView;
  /** Saves the key; resolves truthy when it was saved (the field keeps it otherwise). */
  onSave: (key: string) => Promise<unknown> | unknown;
  onRemove?: () => void | Promise<unknown>;
  disabled?: boolean;
  placeholder?: string;
  /** The input's name (also its accessible name when no label wraps it). */
  name: string;
  inputClassName?: string;
  /** Shown next to the field (a test button). */
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState('');
  const [show, setShow] = useState(false);
  const key = provider?.key;
  const stored = !!key?.set && !key.unreadable;

  const commit = async () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    // Only a key the server took leaves the field; a refused one stays to fix.
    if (await onSave(trimmed)) setValue('');
  };

  return (
    <div className="space-y-1.5">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Input
            name={name}
            aria-label={name}
            type={show ? 'text' : 'password'}
            autoComplete="new-password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder={
              stored
                ? t(`${SC}.keyStoredPlaceholder`, { mask: key?.mask ?? '' })
                : (placeholder ?? t('settings.enterApiKey'))
            }
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commit();
            }}
            disabled={disabled}
            className={cn('h-8 pr-8', inputClassName)}
          />
          <button
            type="button"
            onClick={() => setShow(!show)}
            aria-label={t(show ? `${SC}.hideKey` : `${SC}.showKey`)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        {children}
      </div>
      {key?.unreadable ? (
        <p className="text-xs text-amber-600 dark:text-amber-400">{t(`${SC}.keyUnreadable`)}</p>
      ) : stored ? (
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span>{t(`${SC}.keyStored`, { mask: key?.mask ?? '' })}</span>
          {onRemove && (
            <button
              type="button"
              onClick={() => void onRemove()}
              disabled={disabled}
              className="rounded-sm text-destructive underline-offset-2 hover:underline"
            >
              {t(`${SC}.removeKey`)}
            </button>
          )}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The official regional endpoint of a service that has one per region (Azure
 * Speech): the only endpoint a workspace provider of it takes. Leaving the
 * field (or pressing Enter) saves it.
 */
export function RegionalEndpointField({
  provider,
  template,
  name,
  disabled,
  onSave,
}: {
  provider?: ProviderView;
  /** The endpoint with `<region>` for the region. */
  template: string;
  name: string;
  disabled?: boolean;
  onSave: (baseUrl: string | null) => Promise<unknown> | unknown;
}) {
  const { t } = useI18n();
  const saved = provider?.baseUrl ?? '';
  const [value, setValue] = useState(saved);
  const commit = async () => {
    const trimmed = value.trim();
    if (trimmed === saved) return;
    // A refused endpoint stays in the field to fix.
    if (!(await onSave(trimmed || null))) return;
    setValue(trimmed);
  };
  return (
    <div className="space-y-1.5">
      <Input
        name={name}
        aria-label={name}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        placeholder={template}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commit();
        }}
        disabled={disabled}
        className="h-8 font-mono text-sm"
      />
      <p className="text-xs text-muted-foreground">
        {t(`${SC}.regionalEndpointHint`, { template })}
      </p>
    </div>
  );
}

/** What a service panel may change about its provider. */
export interface ProviderFields {
  apiKey?: string;
  baseUrl?: string | null;
  models?: string[] | null;
}

/**
 * Save a service's provider: add it (with the entry's preset and id) or
 * update it, against the view the panel shows. A provider just added fills
 * the root slots of what it serves that have nothing set yet, as setting up a
 * service always did.
 */
export async function saveServiceProvider(
  view: ModelSettingsView,
  apply: ApplyChange,
  entry: ServiceEntry,
  fields: ProviderFields,
  t: T,
): Promise<ModelSettingsView | null> {
  const preset = entry.provider?.preset ?? entry.preset?.id;
  if (!preset) return null;
  const change: ModelSettingsChange = { kind: 'provider', id: entry.id, preset, ...fields };
  const result = await apply(change, view);
  if (!reportApply(result, t)) return null;
  if (entry.provider) return result.view;
  const set = assignmentsForNewProvider(result.view, entry.id);
  if (!Object.keys(set).length) return result.view;
  const filled = await apply({ kind: 'slots', set }, result.view);
  return reportApply(filled, t) ? filled.view : result.view;
}

/** Remove a workspace provider: its slots follow their parents again. */
export async function removeServiceProvider(
  view: ModelSettingsView,
  apply: ApplyChange,
  providerId: string,
  t: T,
): Promise<boolean> {
  return reportApply(await apply({ kind: 'remove-provider', id: providerId }, view), t);
}

/** The props every Model Services panel takes. */
export interface ServicePanelProps {
  view: ModelSettingsView;
  apply: ApplyChange;
  entry: ServiceEntry;
}

/**
 * Whether the capability's root slot resolves to this provider, and the
 * model it uses: what the service is used for (set in Course Model Config).
 */
export function rootUse(
  view: ModelSettingsView,
  capability: SlotCapability,
  providerId: string,
): { inUse: boolean; modelId?: string; slot?: SlotView } {
  const slot = findSlot(view, ROOT_SLOT[capability]);
  const effective = slot?.effective;
  if (effective?.status !== 'assigned' || effective.providerId !== providerId) {
    return { inUse: false, slot };
  }
  return { inUse: true, modelId: effective.modelId, slot };
}

/** Test a saved chat provider's model on the server (no key leaves the browser). */
export async function verifySavedModel(
  providerId: string,
  modelId: string,
): Promise<{ success: boolean; error?: string }> {
  const response = await fetch('/api/verify-model', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: providerId, model: modelId }),
  });
  return (await response.json()) as { success: boolean; error?: string };
}
