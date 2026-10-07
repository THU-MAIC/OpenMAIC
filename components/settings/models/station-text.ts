import type { ModelSettingsView, SlotView } from '@/lib/model-settings/client';
import { PROVIDER_ONLY_CAPABILITIES, modelName, providerLabel } from '@/lib/model-settings/edit';

import { MS, slotName } from './slot-meta';

type T = (key: string, options?: Record<string, unknown>) => string;

export interface LineText {
  /** The model (or the provider, for its default model), or the slot's state. */
  value: string;
  /** Where it comes from: the provider, the parent it follows, the server's default, a lock. */
  source: string;
  tone: 'own' | 'inherit' | 'off' | 'none' | 'invalid';
}

/** What a slot's line on a card says. */
export function lineText(view: ModelSettingsView, slot: SlotView, t: T): LineText {
  const effective = slot.effective;
  const source = slot.source;
  const follows =
    source.kind === 'inherited'
      ? t(`${MS}.source.inherited`, { name: slotName(t, source.from) })
      : undefined;

  if (effective.status === 'assigned') {
    const provider = providerLabel(view, effective.providerId);
    const value = effective.modelId
      ? modelName(view, slot.capability, effective.providerId, effective.modelId)
      : provider;
    if (follows && !slot.locked) return { value, source: follows, tone: 'inherit' };
    const origin = slot.locked
      ? t(`${MS}.source.locked`)
      : source.kind === 'default'
        ? t(`${MS}.source.default`)
        : undefined;
    // Search and document providers have no model to name: the value is the provider.
    const via = effective.modelId
      ? provider
      : PROVIDER_ONLY_CAPABILITIES.includes(slot.capability)
        ? undefined
        : t(`${MS}.card.providerDefault`);
    return { value, source: [via, origin].filter(Boolean).join(' · '), tone: 'own' };
  }
  const fixed = slot.locked ? t(`${MS}.source.locked`) : undefined;
  if (effective.status === 'disabled') {
    return { value: t(`${MS}.card.off`), source: fixed ?? follows ?? '', tone: 'off' };
  }
  if (effective.status === 'invalid') {
    return { value: t(`${MS}.card.invalid`), source: effective.message, tone: 'invalid' };
  }
  return { value: t(`${MS}.card.unassigned`), source: fixed ?? follows ?? '', tone: 'none' };
}
