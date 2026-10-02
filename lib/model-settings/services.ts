/**
 * Pure helpers behind the settings panels that show the workspace's model
 * configuration the way the settings always have: a list of services per
 * capability (Model Services), the plans (Token Plan) and the model each
 * course stage uses (Course Model). They read the server's view and turn a
 * panel's action into a change; nothing is kept in the browser.
 */
import type { SlotCapability, SlotId } from '@/lib/config/model-slots';
import { presetIdFor } from '@/lib/config/preset-ids';
import type { ThinkingConfig } from '@/lib/types/provider';

import { findSlot, type ModelSettingsChange, type ModelSettingsView } from './client';
import type { PresetView, ProviderView, SlotView } from './client';
import { assignmentRefs, isFillable, modelRef, newProviderId } from './edit';

/** The root slot of each capability: the model a capability uses unless a stage has its own. */
export const ROOT_SLOT: Record<SlotCapability, SlotId> = {
  chat: 'llm',
  image: 'image',
  video: 'video',
  tts: 'tts',
  asr: 'asr',
  webSearch: 'webSearch',
  document: 'document',
};

/**
 * One service in a capability's list:
 * - `deployment`: a provider the server configures (read-only here);
 * - `workspace`: one the workspace added (its key can be kept, replaced or removed);
 * - `available`: a service the workspace can add (no provider yet);
 * - `server-only`: a service only the server can configure (a key pair, a
 *   self-hosted service, or a server that does not let workspaces add providers).
 */
export interface ServiceEntry {
  /** The provider's id, or the id a provider of this service gets when it is added. */
  id: string;
  /** The capability registry's entry that serves it (names, icons, voices). */
  registryId: string;
  state: 'deployment' | 'workspace' | 'available' | 'server-only';
  provider?: ProviderView;
  /** The preset a workspace provider of this service is made from, when the view lists it. */
  preset?: PresetView;
}

/** The registry entry serving a capability for a provider, as the view says (else its preset id). */
export function providerRegistryId(provider: ProviderView, capability: SlotCapability): string {
  return provider.capabilities[capability]?.registryId ?? provider.preset;
}

/**
 * The services a capability's panel lists: the providers that serve it (the
 * server's first), then each registry entry no provider of its preset covers
 * yet, in registry order.
 */
export function serviceEntries(
  view: ModelSettingsView,
  capability: SlotCapability,
  registryIds: readonly string[],
): ServiceEntry[] {
  const entries: ServiceEntry[] = view.providers
    .filter((provider) => provider.capabilities[capability])
    .map((provider) => ({
      id: provider.id,
      registryId: providerRegistryId(provider, capability),
      state: provider.source,
      provider,
      preset: view.presets.find((preset) => preset.id === provider.preset),
    }));
  const taken = new Set(view.providers.map((provider) => provider.id));
  for (const registryId of registryIds) {
    const presetId = presetIdFor(capability, registryId);
    if (view.providers.some((provider) => provider.preset === presetId || provider.id === presetId))
      continue;
    const preset = view.presets.find(
      (entry) => entry.id === presetId && entry.capabilities[capability],
    );
    entries.push({
      id: taken.has(presetId) ? newProviderId(view, presetId) : presetId,
      registryId,
      state: preset ? 'available' : 'server-only',
      ...(preset ? { preset } : {}),
    });
  }
  return entries;
}

/**
 * Whether a service can be used: the server's providers always, the
 * workspace's with a key it can read, and any that needs no key.
 */
export function entryConfigured(entry: ServiceEntry, requiresApiKey = true): boolean {
  if (entry.state === 'deployment') return true;
  // A service that needs no key is ready to use; using it adds it.
  if (entry.state === 'available') return !requiresApiKey;
  if (entry.state !== 'workspace') return false;
  const key = entry.provider?.key;
  return (!!key?.set && !key.unreadable) || !requiresApiKey;
}

/**
 * The root slots a newly added provider fills: each capability it serves
 * whose root has nothing set and is not locked, with its first model (or the
 * provider alone, for services without models to pick).
 */
export function assignmentsForNewProvider(
  view: ModelSettingsView,
  providerId: string,
): Record<string, string> {
  const provider = view.providers.find((entry) => entry.id === providerId);
  if (!provider) return {};
  const set: Record<string, string> = {};
  for (const [capability, offered] of Object.entries(provider.capabilities) as [
    SlotCapability,
    NonNullable<ProviderView['capabilities'][SlotCapability]>,
  ][]) {
    const root = ROOT_SLOT[capability];
    if (!isFillable(findSlot(view, root))) continue;
    const first = offered.models[0]?.id;
    if (capability === 'chat' && !first) continue;
    set[root] = modelRef(providerId, first);
  }
  return set;
}

/** The provider and model a slot resolves to, or null when it resolves to none. */
export function effectiveRef(
  slot: SlotView | undefined,
): { providerId: string; modelId?: string } | null {
  const effective = slot?.effective;
  if (!effective || effective.status !== 'assigned') return null;
  return { providerId: effective.providerId, modelId: effective.modelId };
}

/** Whether a slot resolves to a model (assigned here or inherited). */
export function slotOn(slot: SlotView | undefined): boolean {
  return slot?.effective.status === 'assigned';
}

/** The thinking settings of a slot's own assignment. */
export function slotThinking(slot: SlotView | undefined): ThinkingConfig | undefined {
  const assignment = slot?.assignment;
  return assignment && typeof assignment === 'object'
    ? (assignment.thinking as ThinkingConfig | undefined)
    : undefined;
}

/**
 * The change that sets the thinking settings of the model a slot names
 * itself (its other fields kept). Undefined when the slot has no model of
 * its own: thinking belongs to an assignment.
 */
export function thinkingChange(
  slot: SlotView,
  thinking: ThinkingConfig | undefined,
): ModelSettingsChange | undefined {
  const { model } = assignmentRefs(slot.assignment);
  if (!model) return undefined;
  const existing = typeof slot.assignment === 'object' && slot.assignment ? slot.assignment : {};
  const { thinking: _previous, ...rest } = existing as Record<string, unknown>;
  const next = { ...rest, model, ...(thinking ? { thinking } : {}) };
  const assignment =
    Object.keys(next).length === 1 ? model : (next as Exclude<SlotView['assignment'], undefined>);
  return { kind: 'slots', set: { [slot.slot]: assignment } };
}

/** A token plan's provider in the view: the server's if it has one, else the workspace's. */
export function planProvider(view: ModelSettingsView, presetId: string): ProviderView | undefined {
  const providers = view.providers.filter((provider) => provider.preset === presetId);
  return providers.find((provider) => provider.source === 'deployment') ?? providers[0];
}
