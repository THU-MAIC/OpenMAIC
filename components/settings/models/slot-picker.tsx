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
  type ModelSettingsChange,
  type ModelSettingsView,
  type SlotView,
  type ApplyChange,
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
  splitRef,
  assignmentRefs,
  modelName,
} from '@/lib/model-settings/edit';
import {
  canAddService,
  canResetToServerDefault,
  clearingRestoresDefault,
} from '@/lib/model-settings/shape';
import { cn } from '@/lib/utils';
import { slotRefusesThinkingEffort, type SlotCapability } from '@/lib/config/model-slots';
import { thinkingCapabilityWithoutEffort } from '@/lib/ai/thinking-config';
import {
  assignService,
  keylessServices,
  slotThinking,
  thinkingChange,
  type ServiceEntry,
} from '@/lib/model-settings/services';

import { InlineThinkingControl, ProviderLogo } from '../model-picker';
import { REGISTRY_INFO, entryIcon, entryName, logoInverts, providerLogo } from '../service-display';

import { MS, applyErrorText, slotDescription, slotName } from './slot-meta';
import { lineText } from './station-text';

type T = (key: string, options?: Record<string, unknown>) => string;

const NO_FALLBACK = '__none__';

/**
 * One choice of the picker: a plain button (pressed when it is the slot's
 * current choice). Only one row per list is a Tab stop; the arrow keys move
 * between rows (see {@link rovingKeys}).
 */
function Row({
  current,
  busy,
  disabled,
  tabStop,
  onClick,
  children,
  note,
  logo,
}: {
  logo?: React.ReactNode;
  current?: boolean;
  busy?: boolean;
  disabled?: boolean;
  tabStop: boolean;
  onClick: () => void;
  children: React.ReactNode;
  note?: string;
}) {
  return (
    <button
      type="button"
      data-picker-row=""
      aria-pressed={!!current}
      tabIndex={tabStop ? 0 : -1}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] outline-none transition-colors',
        'hover:bg-muted/70 focus-visible:bg-muted/70 disabled:cursor-not-allowed disabled:opacity-60',
        current && 'bg-primary/10 hover:bg-primary/10',
      )}
    >
      {logo}
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

/**
 * Roving focus over the rows of a list: ArrowUp/ArrowDown step, Home/End jump,
 * Enter/Space choose. Other keys (and keys in the typed-model field) pass.
 */
export function rovingKeys(event: React.KeyboardEvent<HTMLElement>) {
  const target = event.target as HTMLElement;
  if (!target.matches('[data-picker-row]')) return;
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    target.click();
    return;
  }
  const rows = [
    ...event.currentTarget.querySelectorAll<HTMLElement>('[data-picker-row]:not(:disabled)'),
  ];
  const at = rows.indexOf(target);
  const next =
    event.key === 'ArrowDown'
      ? rows[Math.min(at + 1, rows.length - 1)]
      : event.key === 'ArrowUp'
        ? rows[Math.max(at - 1, 0)]
        : event.key === 'Home'
          ? rows[0]
          : event.key === 'End'
            ? rows[rows.length - 1]
            : undefined;
  if (!next) return;
  event.preventDefault();
  next.focus();
}

function GroupLabel({ children, logo }: { children: React.ReactNode; logo?: React.ReactNode }) {
  return (
    <p
      className="flex items-center gap-1.5 truncate px-2 pb-0.5 pt-2 text-[11px] text-muted-foreground"
      role="presentation"
    >
      {logo}
      {children}
    </p>
  );
}

/** A provider's logo for a capability, as Model Services shows it (the generic icon for a custom endpoint). */
function Logo({
  view,
  providerId,
  capability,
  className,
}: {
  view: ModelSettingsView;
  providerId: string;
  capability: SlotCapability;
  className?: string;
}) {
  return (
    <ProviderLogo
      group={{
        name: providerId,
        icon: providerLogo(view, providerId, capability) ?? null,
        invertIcon: logoInverts(view, providerId, capability),
      }}
      className={className ?? 'size-3.5'}
    />
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
  apply: ApplyChange;
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
    try {
      const result = await apply(change, view);
      if (result.ok) {
        if (close) onDone();
        return;
      }
      setMessage(applyErrorText(result, t));
    } finally {
      setBusy(null);
    }
  };
  const pick = (ref: string) => {
    if (current.kind === 'model' && current.model === ref) return onDone();
    void run(ref, modelChange(slot, ref));
  };
  // The thinking settings of the model the slot names itself, when the model has any.
  // A slot whose tool calls cannot carry a reasoning effort (the agent) is not
  // offered effort levels: an effort model it can turn off becomes on/off.
  const thinkingCapability = (() => {
    if (current.kind !== 'model') return undefined;
    const { providerId, modelId } = splitRef(current.model);
    const capability = view.providers
      .find((provider) => provider.id === providerId)
      ?.capabilities.chat?.models.find((model) => model.id === modelId)?.capabilities?.thinking;
    return slotRefusesThinkingEffort(slot.slot)
      ? thinkingCapabilityWithoutEffort(capability)
      : capability;
  })();
  // Services the workspace may add without a key: listed for media slots, added when picked.
  const keyless =
    slot.capability === 'chat' || !canAddService(view, slot.capability)
      ? []
      : keylessServices(
          view,
          slot.capability,
          REGISTRY_INFO[slot.capability].ids,
          REGISTRY_INFO[slot.capability].requiresApiKey,
        );
  const pickKeyless = async (entry: ServiceEntry) => {
    setBusy(entry.id);
    setMessage(null);
    try {
      const result = await assignService(apply, view, entry, slot.slot);
      if (result.ok) onDone();
      else setMessage(applyErrorText(result, t));
    } finally {
      setBusy(null);
    }
  };
  const isCurrent = (ref: string) => current.kind === 'model' && current.model === ref;

  // A default the deployment writes on the slot itself is offered explicitly.
  // While the workspace sets nothing above the slot, dropping the slot's own
  // choice returns to it (and following the parent is not on offer: the
  // default would win); otherwise the default is written as the slot's own.
  const serverDefault = slot.serverDefault !== undefined;
  const restoresDefault = clearingRestoresDefault(view, slot);
  const showFollow = !!parent && !restoresDefault;
  const onDefault = slot.source.kind === 'default';
  const defaultText = (() => {
    if (!serverDefault) return undefined;
    if (slot.serverDefault === null) return t(`${MS}.card.off`);
    const ref = assignmentRefs(slot.serverDefault).model;
    if (!ref) return undefined;
    const { providerId, modelId } = splitRef(ref);
    return modelId
      ? modelName(view, slot.capability, providerId, modelId)
      : providerLabel(view, providerId);
  })();

  // The rows in order, to make the current one (else the first) the Tab stop.
  const rowKeys = [
    ...(serverDefault ? ['default'] : []),
    ...(showFollow ? ['follow'] : []),
    ...(!serverDefault && !parent && slot.assignment !== undefined ? ['clear'] : []),
    ...providers.flatMap((provider) =>
      providerOnly
        ? [provider.id]
        : [
            ...(chat ? [] : [provider.id]),
            ...(provider.capabilities[slot.capability]?.models ?? []).map((model) =>
              modelRef(provider.id, model.id),
            ),
          ],
    ),
    ...(slot.slot !== 'llm' ? ['off'] : []),
  ];
  const currentKey = onDefault
    ? 'default'
    : current.kind === 'model'
      ? current.model
      : current.kind === 'off'
        ? 'off'
        : 'follow';
  const tabStop = rowKeys.includes(currentKey) ? currentKey : rowKeys[0];

  return (
    <div className="flex max-h-[min(420px,var(--radix-popover-content-available-height))] flex-col">
      <div className="border-b px-3 pb-2 pt-2.5">
        <p className="text-[13px] font-semibold leading-tight">{slotName(t, slot.slot)}</p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{text.source || text.value}</p>
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto p-1"
        role="group"
        aria-label={slotName(t, slot.slot)}
        data-slot-picker={slot.slot}
        onKeyDown={rovingKeys}
      >
        {serverDefault && (
          <Row
            tabStop={tabStop === 'default'}
            current={onDefault}
            busy={busy === 'default'}
            disabled={!!busy}
            onClick={() =>
              onDefault
                ? onDone()
                : void run(
                    'default',
                    restoresDefault
                      ? slotChange(slot, { kind: 'follow' })
                      : { kind: 'slots', set: { [slot.slot]: slot.serverDefault! } },
                  )
            }
            note={defaultText}
          >
            {t(
              canResetToServerDefault(slot)
                ? `${MS}.picker.resetDefault`
                : `${MS}.picker.serverDefault`,
            )}
          </Row>
        )}

        {showFollow && parent && (
          <Row
            tabStop={tabStop === 'follow'}
            current={current.kind === 'follow' && !onDefault}
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

        {/* A root with no server default and no parent: dropping its own
            setting leaves it not set. */}
        {!serverDefault && !parent && slot.assignment !== undefined && (
          <Row
            tabStop={tabStop === 'clear'}
            busy={busy === 'follow'}
            disabled={!!busy}
            onClick={() => void run('follow', slotChange(slot, { kind: 'follow' }))}
            note={t(`${MS}.picker.clearHint`)}
          >
            {t(`${MS}.picker.clear`)}
          </Row>
        )}

        {providers.length === 0 && keyless.length === 0 && (
          <p className="px-2 py-2 text-xs text-muted-foreground">{t(`${MS}.picker.noProviders`)}</p>
        )}

        {providerOnly && providers.length > 0 && (
          <>
            <GroupLabel>{t(`${MS}.picker.providers`)}</GroupLabel>
            {providers.map((provider) => (
              <Row
                key={provider.id}
                tabStop={tabStop === provider.id}
                current={isCurrent(provider.id)}
                busy={busy === provider.id}
                disabled={!!busy}
                onClick={() => pick(provider.id)}
                logo={<Logo view={view} providerId={provider.id} capability={slot.capability} />}
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
                <GroupLabel
                  logo={<Logo view={view} providerId={provider.id} capability={slot.capability} />}
                >
                  {providerLabel(view, provider.id)}
                </GroupLabel>
                {!chat && (
                  <Row
                    tabStop={tabStop === provider.id}
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
                      tabStop={tabStop === ref}
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

        {/* Services that need no key (the browser's own speech): added on first use. */}
        {keyless.map((entry) => (
          <div key={entry.id} role="group" aria-label={entryName(entry, slot.capability, t)}>
            <GroupLabel
              logo={
                <ProviderLogo
                  group={{
                    name: entry.id,
                    icon: entryIcon(entry, slot.capability) ?? null,
                  }}
                  className="size-3.5"
                />
              }
            >
              {entryName(entry, slot.capability, t)}
            </GroupLabel>
            <Row
              tabStop={false}
              busy={busy === entry.id}
              disabled={!!busy}
              onClick={() => void pickKeyless(entry)}
            >
              {t(`${MS}.picker.providerDefault`)}
            </Row>
          </div>
        ))}

        {slot.slot !== 'llm' && (
          <>
            <div className="mx-2 my-1 border-t" role="presentation" />
            <Row
              tabStop={tabStop === 'off'}
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

      {chat && current.kind === 'model' && thinkingCapability && (
        <div
          className="flex items-center gap-2 border-t px-3 py-2"
          aria-label={t(`${MS}.picker.thinking`)}
          role="group"
        >
          <span className="shrink-0 text-xs text-muted-foreground">
            {t(`${MS}.picker.thinking`)}
          </span>
          <InlineThinkingControl
            capability={thinkingCapability}
            config={slotThinking(slot)}
            onChange={(config) => {
              const change = thinkingChange(slot, config);
              if (change) void run('thinking', change, false);
            }}
            t={t}
          />
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
