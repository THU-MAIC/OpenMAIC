/**
 * Pure helpers behind the model settings UI: reading a slot's state, turning
 * an editor choice into a change, the first-run wizard's assignments and the
 * provider form's change. Kept apart from the components so they can be
 * tested without a DOM.
 */
import type { SlotCapability } from '@/lib/config/model-slots';

import type {
  ModelSettingsChange,
  ModelSettingsView,
  PresetView,
  ProviderView,
  SlotView,
} from './client';

/** A slot's own assignment: null turns it off. */
type SlotAssignment = Exclude<SlotView['assignment'], undefined>;

/** Capabilities whose providers serve without a model to pick. */
export const PROVIDER_ONLY_CAPABILITIES: readonly SlotCapability[] = ['webSearch', 'document'];

/** `providerId:modelId`, or the provider alone for its default model. */
export function modelRef(providerId: string, modelId?: string): string {
  return modelId ? `${providerId}:${modelId}` : providerId;
}

/** Split a reference at its first colon: model ids may contain colons. */
export function splitRef(ref: string): { providerId: string; modelId?: string } {
  const at = ref.indexOf(':');
  return at < 0
    ? { providerId: ref }
    : { providerId: ref.slice(0, at), modelId: ref.slice(at + 1) || undefined };
}

/** The model and fallback references an assignment names. */
export function assignmentRefs(assignment: SlotAssignment | undefined): {
  model?: string;
  fallback?: string;
} {
  if (assignment === undefined || assignment === null) return {};
  if (typeof assignment === 'string') return { model: assignment };
  return { model: assignment.model, fallback: assignment.fallback };
}

/** What the card editor can set a slot to. */
export type SlotChoice =
  | { kind: 'follow' }
  | { kind: 'off' }
  | { kind: 'model'; model: string; fallback?: string };

/** Whether a reference is complete for a capability: chat needs a model. */
export function refComplete(ref: string | undefined, capability: SlotCapability): boolean {
  if (!ref) return false;
  const { providerId, modelId } = splitRef(ref);
  return !!providerId && (capability !== 'chat' || !!modelId);
}

/** The editor's starting choice: what the workspace itself wrote for the slot. */
export function currentChoice(slot: SlotView): SlotChoice {
  if (slot.assignment === undefined) return { kind: 'follow' };
  if (slot.assignment === null) return { kind: 'off' };
  const { model, fallback } = assignmentRefs(slot.assignment);
  return { kind: 'model', model: model ?? '', ...(fallback ? { fallback } : {}) };
}

/**
 * The change that sets a slot to a choice. An object assignment keeps its
 * other fields (agent transport, context window); thinking settings stay only
 * while the model stays the same, since they are specific to it.
 */
export function slotChange(slot: SlotView, choice: SlotChoice): ModelSettingsChange {
  if (choice.kind === 'follow') return { kind: 'slots', clear: [slot.slot] };
  if (choice.kind === 'off') return { kind: 'slots', set: { [slot.slot]: null } };

  const existing =
    slot.assignment && typeof slot.assignment === 'object' ? slot.assignment : undefined;
  const {
    model: previousModel,
    fallback: _fallback,
    thinking,
    ...rest
  } = existing ?? { model: undefined };
  const keep = {
    ...rest,
    ...(thinking && previousModel === choice.model ? { thinking } : {}),
  };
  const fallback = slot.capability === 'chat' ? choice.fallback : undefined;
  const assignment: SlotAssignment =
    fallback || Object.keys(keep).length
      ? { ...keep, model: choice.model, ...(fallback ? { fallback } : {}) }
      : choice.model;
  return { kind: 'slots', set: { [slot.slot]: assignment } };
}

/** Pick a model for a slot, keeping the fallback it has. */
export function modelChange(slot: SlotView, ref: string): ModelSettingsChange {
  const { fallback } = assignmentRefs(slot.assignment);
  return slotChange(slot, { kind: 'model', model: ref, ...(fallback ? { fallback } : {}) });
}

/** Set or drop the fallback of a slot that has a model of its own. */
export function fallbackChange(slot: SlotView, ref: string | undefined): ModelSettingsChange {
  const { model } = assignmentRefs(slot.assignment);
  if (!model) throw new Error(`${slot.slot} has no model of its own`);
  return slotChange(slot, { kind: 'model', model, ...(ref ? { fallback: ref } : {}) });
}

/**
 * The change behind a card's switch: off writes `null`; on drops the `null`
 * so the slot resolves as before (its parent, the server's value or default).
 */
export function toggleChange(slot: SlotView, on: boolean): ModelSettingsChange {
  return on ? { kind: 'slots', clear: [slot.slot] } : { kind: 'slots', set: { [slot.slot]: null } };
}

/** Providers that offer a capability, deployment ones first as the server lists them. */
export function providersFor(view: ModelSettingsView, capability: SlotCapability): ProviderView[] {
  return view.providers.filter((provider) => provider.capabilities[capability]);
}

/** The display name of a model a provider offers, else its id. */
export function modelName(
  view: ModelSettingsView,
  capability: SlotCapability,
  providerId: string,
  modelId: string,
): string {
  const provider = view.providers.find((entry) => entry.id === providerId);
  return provider?.capabilities[capability]?.models.find((m) => m.id === modelId)?.name ?? modelId;
}

/** The preset a provider was made from, when the view lists it. */
export function presetOf(view: ModelSettingsView, provider: ProviderView): PresetView | undefined {
  return view.presets.find((preset) => preset.id === provider.preset);
}

/** Slots the first-run wizard may fill: shown, unlocked, not set and resolving to nothing. */
export function isFillable(slot: SlotView | undefined): slot is SlotView {
  return (
    !!slot &&
    !slot.locked &&
    !slot.configOnly &&
    slot.assignment === undefined &&
    slot.effective.status === 'unassigned'
  );
}

/**
 * The assignments the first-run wizard writes after adding a provider of a
 * preset: the preset's recommendations for every slot still empty (prefixed
 * with the new provider's id), and at least `llm` on the provider's first
 * chat model. Reads the view returned after adding the provider, so a model
 * list the user gave counts.
 */
export function wizardAssignments(
  view: ModelSettingsView,
  preset: PresetView,
  providerId: string,
): Record<string, string> {
  const slots = new Map<string, SlotView>(view.slots.map((slot) => [slot.slot, slot]));
  const set: Record<string, string> = {};
  for (const [slot, model] of Object.entries(preset.recommended)) {
    if (model && isFillable(slots.get(slot))) set[slot] = modelRef(providerId, model);
  }
  if (!set.llm && isFillable(slots.get('llm'))) {
    const provider = view.providers.find((entry) => entry.id === providerId);
    const first =
      provider?.capabilities.chat?.models[0]?.id ?? preset.capabilities.chat?.models[0]?.id;
    if (first) set.llm = modelRef(providerId, first);
  }
  return set;
}

const PROVIDER_ID_MAX = 63;

/** A provider id for a new provider of a preset, unique among the view's providers. */
export function newProviderId(view: ModelSettingsView, presetId: string): string {
  const base =
    presetId
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, PROVIDER_ID_MAX - 4) || 'provider';
  const taken = new Set(view.providers.map((provider) => provider.id));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** What the provider form holds. */
export interface ProviderDraft {
  preset: string;
  /** For an existing provider: keep the stored key, replace it, or remove it. */
  keyAction: 'keep' | 'replace' | 'remove';
  apiKey: string;
  baseUrl: string;
  /** Model ids, separated by commas or new lines. */
  models: string;
}

export function emptyDraft(preset: string): ProviderDraft {
  return { preset, keyAction: 'replace', apiKey: '', baseUrl: '', models: '' };
}

export function draftFor(provider: ProviderView): ProviderDraft {
  return {
    preset: provider.preset,
    keyAction: provider.key?.set ? 'keep' : 'replace',
    apiKey: '',
    baseUrl: provider.baseUrl ?? '',
    models: (provider.models ?? []).join(', '),
  };
}

export function parseModelList(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

/** Which of the provider form's optional fields apply to a preset. */
export function providerFields(preset: PresetView | undefined, draft?: ProviderDraft) {
  if (!preset) return { baseUrl: false, baseUrlRequired: false, models: false };
  const chat = preset.capabilities.chat;
  const baseUrl = preset.requiresBaseUrl || preset.customEndpoint;
  return {
    baseUrl,
    baseUrlRequired: preset.requiresBaseUrl,
    // A chat provider needs its model list when the preset has no catalogue
    // or points somewhere the catalogue may not describe.
    models:
      !!chat && (preset.requiresBaseUrl || chat.models.length === 0 || !!draft?.baseUrl.trim()),
  };
}

/** Why the form cannot be saved yet, or undefined when it can. */
export function draftProblem(
  preset: PresetView | undefined,
  draft: ProviderDraft,
): 'preset' | 'baseUrl' | 'models' | undefined {
  if (!preset) return 'preset';
  const fields = providerFields(preset, draft);
  if (fields.baseUrlRequired && !draft.baseUrl.trim()) return 'baseUrl';
  if (
    fields.models &&
    preset.capabilities.chat?.models.length === 0 &&
    !parseModelList(draft.models).length
  ) {
    return 'models';
  }
  return undefined;
}

/**
 * The change that saves the form: adds the provider (`existing` undefined) or
 * updates it. For an update, an emptied base URL or model list is removed and
 * the key follows `keyAction`; for a new provider empty fields are left out.
 */
export function providerChange(
  id: string,
  draft: ProviderDraft,
  preset: PresetView | undefined,
  existing?: ProviderView,
): ModelSettingsChange {
  const fields = providerFields(preset, draft);
  const baseUrl = fields.baseUrl ? draft.baseUrl.trim() : '';
  const models = fields.models ? parseModelList(draft.models) : [];
  const apiKey = draft.apiKey.trim();
  const change: Extract<ModelSettingsChange, { kind: 'provider' }> = {
    kind: 'provider',
    id,
    preset: draft.preset,
  };
  if (existing) {
    if (draft.keyAction === 'remove') change.apiKey = '';
    else if (draft.keyAction === 'replace' && apiKey) change.apiKey = apiKey;
    change.baseUrl = baseUrl || null;
    change.models = models.length ? models : null;
  } else {
    if (apiKey) change.apiKey = apiKey;
    if (baseUrl) change.baseUrl = baseUrl;
    if (models.length) change.models = models;
  }
  return change;
}

/** Presets grouped for the picker: bundles first, then by what they offer. */
export const PRESET_GROUPS = [
  'bundle',
  'chat',
  'tts',
  'asr',
  'image',
  'video',
  'webSearch',
  'document',
] as const;
export type PresetGroup = (typeof PRESET_GROUPS)[number];

export function presetGroup(preset: PresetView): PresetGroup {
  if (preset.kind === 'token-plan') return 'bundle';
  const capabilities = Object.keys(preset.capabilities) as SlotCapability[];
  return capabilities.includes('chat') ? 'chat' : (capabilities[0] ?? 'chat');
}

export function groupPresets(
  presets: readonly PresetView[],
): { group: PresetGroup; presets: PresetView[] }[] {
  return PRESET_GROUPS.map((group) => ({
    group,
    presets: presets.filter((preset) => presetGroup(preset) === group),
  })).filter((entry) => entry.presets.length > 0);
}

/** Where a slot's effective value comes from, for its card. */
export type SlotSource =
  | { kind: 'own' }
  | { kind: 'deployment' }
  | { kind: 'default' }
  | { kind: 'inherited'; from: string }
  | { kind: 'none' };

export function slotSource(slot: SlotView): SlotSource {
  const effective = slot.effective;
  if (effective.status === 'assigned' || effective.status === 'disabled') {
    if (effective.resolvedAt !== slot.slot)
      return { kind: 'inherited', from: effective.resolvedAt };
    if (effective.source === 'deployment') return { kind: 'deployment' };
    if (effective.source === 'default') return { kind: 'default' };
    return { kind: 'own' };
  }
  if (slot.locked) return { kind: 'deployment' };
  if (slot.assignment !== undefined) return { kind: 'own' };
  return slot.parent ? { kind: 'inherited', from: slot.parent } : { kind: 'none' };
}

/** A slot that merely follows its parent: nothing of its own, nothing locked. */
export function followsParent(slot: SlotView): boolean {
  return slot.parent !== null && !slot.locked && slot.assignment === undefined;
}

/** The i18n key segment for a slot id (`course.content.slide` → `courseContentSlide`). */
export function slotKey(slot: string): string {
  return slot.replace(/\.(\w)/g, (_, char: string) => char.toUpperCase());
}

/**
 * A provider's name for display: its preset's name when the provider is named
 * after the preset, else its own id (two providers of one preset stay apart).
 */
export function providerLabel(view: ModelSettingsView, providerId: string): string {
  const provider = view.providers.find((entry) => entry.id === providerId);
  const preset = provider ? presetOf(view, provider) : undefined;
  return preset && preset.id === providerId ? preset.name : providerId;
}

type Apply = (
  change: ModelSettingsChange,
) => Promise<
  { ok: true; view: ModelSettingsView } | { ok: false; reason: string; message: string }
>;

export type FirstRunResult =
  | { status: 'done'; providerId: string; assigned: string[] }
  /** The provider could not be added. */
  | { status: 'failed'; reason: string; message: string }
  /**
   * The provider was added but the slots could not be filled: the server
   * refused them (`message`), or the provider offers no chat model to use.
   */
  | { status: 'partial'; providerId: string; message?: string };

/**
 * The first-run wizard: add a provider of the preset, then fill the slots
 * still empty with its recommendations (see {@link wizardAssignments}).
 */
export async function runFirstRunSetup(
  apply: Apply,
  view: ModelSettingsView,
  preset: PresetView,
  draft: ProviderDraft,
): Promise<FirstRunResult> {
  const providerId = newProviderId(view, preset.id);
  const added = await apply(providerChange(providerId, draft, preset));
  if (!added.ok) return { status: 'failed', reason: added.reason, message: added.message };
  const set = wizardAssignments(added.view, preset, providerId);
  const assigned = Object.keys(set);
  if (!assigned.length) {
    return { status: 'partial', providerId };
  }
  const filled = await apply({ kind: 'slots', set });
  if (!filled.ok) return { status: 'partial', providerId, message: filled.message };
  return { status: 'done', providerId, assigned };
}
