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
    effective: { status: 'unassigned' },
  }));
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
    policy: { allowWorkspaceProviders: true },
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
    slots: view.slots.map((slot) => (patch[slot.slot] ? { ...slot, ...patch[slot.slot] } : slot)),
  };
}
