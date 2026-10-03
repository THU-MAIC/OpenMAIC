import { MODEL_SLOTS } from '@/lib/config/model-slots';
import type {
  ModelSettingsView,
  PresetView,
  ProviderView,
  SlotView,
} from '@/lib/model-settings/client';

/** Every slot unassigned and unlocked, as a fresh workspace without a deployment sees them. */
export function emptySlots(): SlotView[] {
  return MODEL_SLOTS.map((slot) => ({
    slot: slot.id,
    parent: slot.parent,
    capability: slot.capability,
    configOnly: 'configOnly' in slot && slot.configOnly === true,
    locked: false,
    source: { kind: 'unconfigured' },
    effective: { status: 'unassigned' },
  }));
}

/**
 * Where a slot's value comes from, as the server works it out, for a slot a
 * test patched without saying: the node that resolved it, else its own
 * assignment, else a lock.
 */
export function derivedSource(slot: SlotView): SlotView['source'] {
  const effective = slot.effective;
  if (effective.status === 'assigned' || effective.status === 'disabled') {
    if (effective.resolvedAt !== slot.slot)
      return { kind: 'inherited', from: effective.resolvedAt };
    return { kind: effective.source };
  }
  if (slot.locked) return { kind: 'locked' };
  if (slot.assignment !== undefined) return { kind: 'workspace' };
  if (slot.serverDefault !== undefined) return { kind: 'default' };
  return { kind: 'unconfigured' };
}

export const chatPreset: PresetView = {
  id: 'acme',
  name: 'Acme',
  kind: 'token-plan',
  capabilities: {
    chat: {
      models: [
        { id: 'acme-large', name: 'Acme Large' },
        { id: 'acme-small', name: 'Acme Small' },
      ],
    },
    tts: { models: [{ id: 'acme-voice', name: 'Acme Voice' }] },
    webSearch: { models: [] },
  },
  requiresBaseUrl: false,
  customEndpoint: true,
  recommended: {
    llm: 'acme-large',
    'course.content.slide': 'acme-small',
    tts: 'acme-voice',
    'agent.title': 'acme-small',
  },
};

export const compatiblePreset: PresetView = {
  id: 'openai-compatible',
  name: 'OpenAI-compatible endpoint',
  kind: 'single',
  capabilities: { chat: { models: [] } },
  requiresBaseUrl: true,
  customEndpoint: true,
  recommended: {},
};

export function workspaceProvider(id: string, preset = chatPreset): ProviderView {
  return {
    id,
    preset: preset.id,
    source: 'workspace',
    capabilities: preset.capabilities,
    key: { set: true, mask: '…abcd' },
  };
}

export function makeView(overrides: Partial<ModelSettingsView> = {}): ModelSettingsView {
  return {
    revision: null,
    allowUserKeys: true,
    presets: [chatPreset, compatiblePreset],
    providers: [],
    slots: emptySlots(),
    ...overrides,
  };
}

/** A copy of the view with some slots replaced. */
export function withSlots(
  view: ModelSettingsView,
  patch: Record<string, Partial<SlotView>>,
): ModelSettingsView {
  return {
    ...view,
    slots: view.slots.map((slot) => {
      const changed = patch[slot.slot];
      if (!changed) return slot;
      const next = { ...slot, ...changed };
      return changed.source ? next : { ...next, source: derivedSource(next) };
    }),
  };
}

/** The view with `llm` set to a workspace provider's model, as the server answers it. */
export function withLlm(view: ModelSettingsView, ref = 'acme:acme-large'): ModelSettingsView {
  const [providerId, modelId] = ref.split(':');
  return withSlots(view, {
    llm: {
      assignment: ref,
      effective: {
        status: 'assigned',
        resolvedAt: 'llm',
        source: 'workspace',
        requirements: [],
        providerId,
        providerSource: 'workspace',
        presetId: providerId,
        registryId: 'x',
        modelId,
      },
    },
  });
}
