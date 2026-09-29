'use client';

import { useState } from 'react';
import { AlertCircle, Info, Loader2 } from 'lucide-react';

import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  findSlot,
  type ApplyResult,
  type ModelSettingsChange,
  type ModelSettingsView,
  type SlotView,
} from '@/lib/model-settings/client';
import {
  PROVIDER_ONLY_CAPABILITIES,
  currentChoice,
  fallbackChange,
  modelChange,
  modelRef,
  providerLabel,
  providersFor,
  slotChange,
} from '@/lib/model-settings/edit';
import { cn } from '@/lib/utils';

import { MS, slotDescription, slotName } from './slot-meta';
import { lineText } from './station-text';

type T = (key: string, options?: Record<string, unknown>) => string;

const NO_FALLBACK = '__none__';

function Row({
  current,
  busy,
  disabled,
  onClick,
  children,
  note,
}: {
  current?: boolean;
  busy?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  note?: string;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={!!current}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] outline-none transition-colors',
        'hover:bg-muted/70 focus-visible:bg-muted/70 disabled:cursor-not-allowed disabled:opacity-60',
        current && 'bg-primary/10 hover:bg-primary/10',
      )}
    >
      <span className="min-w-0 max-w-[80%] shrink-0 truncate">{children}</span>
      {note && (
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{note}</span>
      )}
      <span className="ml-auto flex shrink-0 items-center">
        {busy ? (
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden="true" />
        ) : (
          current && <span className="size-1.5 rounded-full bg-primary" aria-hidden="true" />
        )}
      </span>
    </button>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="truncate px-2 pb-0.5 pt-2 text-[11px] text-muted-foreground" role="presentation">
      {children}
    </p>
  );
}

/** A model id typed for a chat provider without a catalogue. */
function TypedModel({
  providerId,
  onUse,
  disabled,
  t,
}: {
  providerId: string;
  onUse: (ref: string) => void;
  disabled?: boolean;
  t: T;
}) {
  const [value, setValue] = useState('');
  return (
    <form
      className="flex items-center gap-1.5 px-2 py-1"
      onSubmit={(event) => {
        event.preventDefault();
        if (value.trim()) onUse(modelRef(providerId, value.trim()));
      }}
    >
      <Input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={t(`${MS}.picker.modelId`)}
        aria-label={t(`${MS}.picker.modelId`)}
        className="h-7 font-mono text-xs"
      />
      <button
        type="submit"
        disabled={disabled || !value.trim()}
        className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10 disabled:opacity-50"
      >
        {t(`${MS}.picker.use`)}
      </button>
    </form>
  );
}

/**
 * The inline picker of a slot: follow its parent, one of the models the
 * providers offer for its capability, or off; for a chat slot with a model of
 * its own, a fallback. A choice is saved at once.
 */
export function SlotPicker({
  view,
  slot,
  apply,
  onDone,
  onManageProviders,
  t,
}: {
  view: ModelSettingsView;
  slot: SlotView;
  apply: (change: ModelSettingsChange) => Promise<ApplyResult>;
  onDone: () => void;
  onManageProviders?: () => void;
  t: T;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const current = currentChoice(slot);
  const parent = slot.parent ? findSlot(view, slot.parent) : undefined;
  const providers = providersFor(view, slot.capability);
  const providerOnly = PROVIDER_ONLY_CAPABILITIES.includes(slot.capability);
  const chat = slot.capability === 'chat';
  const text = lineText(view, slot, t);
  const description = slotDescription(t, slot.slot);

  const run = async (key: string, change: ModelSettingsChange, close = true) => {
    setBusy(key);
    setMessage(null);
    const result = await apply(change);
    setBusy(null);
    if (result.ok) {
      if (close) onDone();
      return;
    }
    setMessage(
      result.reason === 'conflict'
        ? t(`${MS}.picker.conflict`)
        : result.reason === 'locked'
          ? t(`${MS}.picker.lockedNow`)
          : result.message,
    );
  };
  const pick = (ref: string) => {
    if (current.kind === 'model' && current.model === ref) return onDone();
    void run(ref, modelChange(slot, ref));
  };
  const isCurrent = (ref: string) => current.kind === 'model' && current.model === ref;

  return (
    <div className="flex max-h-[min(420px,var(--radix-popover-content-available-height))] flex-col">
      <div className="border-b px-3 pb-2 pt-2.5">
        <p className="text-[13px] font-semibold leading-tight">{slotName(t, slot.slot)}</p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{text.source || text.value}</p>
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto p-1"
        role="listbox"
        aria-label={slotName(t, slot.slot)}
      >
        {parent && (
          <Row
            current={current.kind === 'follow'}
            busy={busy === 'follow'}
            disabled={!!busy}
            onClick={() =>
              current.kind === 'follow'
                ? onDone()
                : void run('follow', slotChange(slot, { kind: 'follow' }))
            }
            note={lineText(view, parent, t).value}
          >
            {t(`${MS}.picker.follow`, { name: slotName(t, parent.slot) })}
          </Row>
        )}

        {/* A root has no parent to follow: dropping its own setting leaves
            whatever the server provides (its value or default), if anything. */}
        {!parent && slot.assignment !== undefined && (
          <Row
            busy={busy === 'follow'}
            disabled={!!busy}
            onClick={() => void run('follow', slotChange(slot, { kind: 'follow' }))}
            note={t(`${MS}.picker.clearHint`)}
          >
            {t(`${MS}.picker.clear`)}
          </Row>
        )}

        {providers.length === 0 && (
          <p className="px-2 py-2 text-xs text-muted-foreground">{t(`${MS}.picker.noProviders`)}</p>
        )}

        {providerOnly && providers.length > 0 && (
          <>
            <GroupLabel>{t(`${MS}.picker.providers`)}</GroupLabel>
            {providers.map((provider) => (
              <Row
                key={provider.id}
                current={isCurrent(provider.id)}
                busy={busy === provider.id}
                disabled={!!busy}
                onClick={() => pick(provider.id)}
              >
                {providerLabel(view, provider.id)}
              </Row>
            ))}
          </>
        )}

        {!providerOnly &&
          providers.map((provider) => {
            const models = provider.capabilities[slot.capability]?.models ?? [];
            return (
              <div key={provider.id} role="group" aria-label={providerLabel(view, provider.id)}>
                <GroupLabel>{providerLabel(view, provider.id)}</GroupLabel>
                {!chat && (
                  <Row
                    current={isCurrent(provider.id)}
                    busy={busy === provider.id}
                    disabled={!!busy}
                    onClick={() => pick(provider.id)}
                  >
                    {t(`${MS}.picker.providerDefault`)}
                  </Row>
                )}
                {models.map((model) => {
                  const ref = modelRef(provider.id, model.id);
                  return (
                    <Row
                      key={model.id}
                      current={isCurrent(ref)}
                      busy={busy === ref}
                      disabled={!!busy}
                      onClick={() => pick(ref)}
                    >
                      {model.name}
                    </Row>
                  );
                })}
                {chat && models.length === 0 && (
                  <TypedModel providerId={provider.id} onUse={pick} disabled={!!busy} t={t} />
                )}
              </div>
            );
          })}

        {slot.slot !== 'llm' && (
          <>
            <div className="mx-2 my-1 border-t" role="presentation" />
            <Row
              current={current.kind === 'off'}
              busy={busy === 'off'}
              disabled={!!busy}
              onClick={() =>
                current.kind === 'off'
                  ? onDone()
                  : void run('off', slotChange(slot, { kind: 'off' }))
              }
              note={t(`${MS}.picker.offHint`)}
            >
              {t(`${MS}.picker.off`)}
            </Row>
          </>
        )}
      </div>

      {chat && current.kind === 'model' && (
        <div className="flex items-center gap-2 border-t px-3 py-2">
          <span className="shrink-0 text-xs text-muted-foreground">
            {t(`${MS}.picker.fallback`)}
          </span>
          <Select
            value={current.fallback ?? NO_FALLBACK}
            onValueChange={(value) =>
              void run(
                'fallback',
                fallbackChange(slot, value === NO_FALLBACK ? undefined : value),
                false,
              )
            }
            disabled={!!busy}
          >
            <SelectTrigger
              size="sm"
              className="h-7 min-w-0 flex-1 text-xs"
              aria-label={t(`${MS}.picker.fallback`)}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value={NO_FALLBACK} className="text-xs">
                {t(`${MS}.picker.noFallback`)}
              </SelectItem>
              {providersFor(view, 'chat').map((provider) => (
                <SelectGroup key={provider.id}>
                  <SelectLabel className="text-[11px]">
                    {providerLabel(view, provider.id)}
                  </SelectLabel>
                  {(provider.capabilities.chat?.models ?? []).map((model) => (
                    <SelectItem
                      key={model.id}
                      value={modelRef(provider.id, model.id)}
                      className="text-xs"
                    >
                      {model.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {message && (
        <p
          role="alert"
          className="mx-2 mb-2 flex items-start gap-1.5 rounded-md bg-destructive/10 px-2.5 py-2 text-[11px] leading-relaxed text-destructive"
        >
          <AlertCircle className="mt-px size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 break-words">{message}</span>
        </p>
      )}

      {(description || onManageProviders) && (
        <div className="flex items-start gap-1.5 border-t px-3 py-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0">
            {description && <>{description} </>}
            {onManageProviders && (
              <button
                type="button"
                onClick={onManageProviders}
                className="font-medium text-primary underline-offset-2 hover:underline"
              >
                {t(`${MS}.picker.manageProviders`)}
              </button>
            )}
          </span>
        </div>
      )}
    </div>
  );
}
