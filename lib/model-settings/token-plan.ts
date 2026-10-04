/**
 * Connecting a token plan from the Token Plan settings: the plan's recommended
 * configuration and the slot change that applies it.
 *
 * A plan is a workspace provider of a token-plan preset. Connecting it (or
 * saving a new key for it) assigns the preset's recommendations — the default
 * model, the course stages it names, and its image, video, speech and search
 * services — to the slots, as one `slots` change against the view's revision.
 * Assignments the workspace already made for those slots are replaced when
 * the user chooses the plan's setup, and kept otherwise (only empty slots are
 * filled). Slots the deployment locks are never touched.
 *
 * When several plans are connected, a plan does not take the slots a
 * higher-priority plan recommends (priority is the order of
 * `TOKEN_PLAN_PRESETS`), whichever was connected first. Disconnecting is
 * removing the plan's provider: the server drops the assignments that name it,
 * so those slots follow their parents again.
 *
 * Pure functions over the server's view, so they can be tested without a DOM.
 */
import { tokenPlanPresetId } from '@/lib/config/preset-ids';
import { TOKEN_PLAN_PRESETS } from '@/lib/config/token-plan-presets';

import {
  isLlmConfigured,
  type ApplyResult,
  type ModelSettingsChange,
  type ModelSettingsView,
  type PresetView,
  type ProviderView,
  type SlotView,
} from './client';
import {
  assignmentRefs,
  emptyDraft,
  modelRef,
  newProviderId,
  providerChange,
  slotChange,
  type FirstRunResult,
} from './edit';

type SlotAssignment = Exclude<SlotView['assignment'], undefined>;

/** The provider a plan is (or would be, once added) in the workspace. */
export type PlanProvider = Pick<ProviderView, 'id' | 'capabilities'>;

/** The plans in priority order, as preset ids. */
const PLAN_PRESET_ORDER = TOKEN_PLAN_PRESETS.map((plan) => tokenPlanPresetId(plan.id));

/** A provider that can serve now: the deployment's, or the workspace's with a readable key. */
function usable(provider: ProviderView): boolean {
  return provider.source === 'deployment' || (!!provider.key?.set && !provider.key.unreadable);
}

/**
 * The plan's provider in the workspace: the workspace's own one (the one a
 * key can be saved for), else none.
 */
export function workspacePlanProvider(
  view: ModelSettingsView,
  presetId: string,
): ProviderView | undefined {
  return view.providers.find(
    (provider) => provider.preset === presetId && provider.source === 'workspace',
  );
}

/**
 * The slots held by connected plans of higher priority than `presetId`: the
 * slots each of them recommends. Whether they currently point at that plan
 * does not matter, so the outcome does not depend on the order the plans were
 * connected in.
 */
export function slotsHeldByHigherPlans(view: ModelSettingsView, presetId: string): Set<string> {
  const held = new Set<string>();
  const rank = PLAN_PRESET_ORDER.indexOf(presetId);
  if (rank <= 0) return held;
  for (const higher of PLAN_PRESET_ORDER.slice(0, rank)) {
    const connected = view.providers.some(
      (provider) => provider.preset === higher && usable(provider),
    );
    if (!connected) continue;
    const preset = view.presets.find((entry) => entry.id === higher);
    for (const slot of Object.keys(preset?.recommended ?? {})) held.add(slot);
  }
  return held;
}

/**
 * The plan's recommended assignment per slot, prefixed with its provider's
 * id: the preset's recommendations, checked against what the provider offers,
 * and at least `llm` on the provider's first chat model. Leaves out slots the
 * deployment locks, slots not shown in the settings, and slots a
 * higher-priority connected plan holds.
 */
export function tokenPlanRecommendation(
  view: ModelSettingsView,
  preset: PresetView,
  provider: PlanProvider,
): Record<string, string> {
  const slots = new Map<string, SlotView>(view.slots.map((slot) => [slot.slot, slot]));
  const held = slotsHeldByHigherPlans(view, preset.id);
  const open = (slot: SlotView | undefined): slot is SlotView =>
    !!slot && !slot.locked && !slot.configOnly && !held.has(slot.slot);
  const recommendation: Record<string, string> = {};
  for (const [slotId, model] of Object.entries(preset.recommended)) {
    const slot = slots.get(slotId);
    if (!model || !open(slot)) continue;
    const offered = provider.capabilities[slot.capability];
    if (!offered) continue;
    if (offered.models.some((entry) => entry.id === model)) {
      recommendation[slotId] = modelRef(provider.id, model);
    } else if (offered.models.length === 0 && slot.capability !== 'chat') {
      // A service without models to pick (web search): the provider by itself.
      recommendation[slotId] = provider.id;
    }
  }
  const first = provider.capabilities.chat?.models[0]?.id;
  if (!recommendation.llm && first && open(slots.get('llm'))) {
    recommendation.llm = modelRef(provider.id, first);
  }
  return recommendation;
}

/** A slot whose own assignment the plan's recommendation would replace. */
export interface PlanConflict {
  slot: SlotView;
  /** What the workspace assigned (null: turned off). */
  current: SlotAssignment;
  recommended: string;
}

/** Whether a slot already holds the recommended model. */
function holds(slot: SlotView, ref: string): boolean {
  return assignmentRefs(slot.assignment).model === ref;
}

/**
 * The slots where applying the recommendation would replace something the
 * workspace chose: they have an assignment of their own (a model, or off)
 * that differs from the plan's. Empty slots and slots that already match are
 * not conflicts.
 */
export function tokenPlanConflicts(
  view: ModelSettingsView,
  recommendation: Record<string, string>,
): PlanConflict[] {
  const conflicts: PlanConflict[] = [];
  for (const slot of view.slots) {
    const recommended = recommendation[slot.slot];
    if (recommended === undefined || slot.assignment === undefined) continue;
    if (holds(slot, recommended)) continue;
    conflicts.push({ slot, current: slot.assignment, recommended });
  }
  return conflicts;
}

/**
 * How connecting treats the slots the workspace already set:
 * - `overwrite`: the plan's recommended setup replaces them;
 * - `keep`: they stay; only the slots with nothing of their own are filled.
 */
export type PlanApplyMode = 'overwrite' | 'keep';

/**
 * The assignments that apply a recommendation. A replaced language-model
 * assignment keeps its fallback and other settings (as picking a model in the
 * course model map does); thinking settings go, as they are specific to the
 * model they were set for. Slots that already hold the recommended model are
 * left out.
 */
export function tokenPlanAssignments(
  view: ModelSettingsView,
  recommendation: Record<string, string>,
  mode: PlanApplyMode,
): Record<string, SlotAssignment> {
  const set: Record<string, SlotAssignment> = {};
  for (const slot of view.slots) {
    const recommended = recommendation[slot.slot];
    if (recommended === undefined || holds(slot, recommended)) continue;
    if (slot.assignment !== undefined && mode === 'keep') continue;
    const { fallback } = assignmentRefs(slot.assignment);
    const change = slotChange(slot, {
      kind: 'model',
      model: recommended,
      ...(fallback && fallback !== recommended ? { fallback } : {}),
    });
    if (change.kind === 'slots') Object.assign(set, change.set);
  }
  return set;
}

/** The provider the plan would be: the workspace's, or a new one named after the preset. */
export function prospectivePlanProvider(view: ModelSettingsView, preset: PresetView): PlanProvider {
  return (
    workspacePlanProvider(view, preset.id) ?? {
      id: newProviderId(view, preset.id),
      capabilities: preset.capabilities,
    }
  );
}

/** The conflicts connecting a plan would raise, before anything is written. */
export function connectConflicts(view: ModelSettingsView, preset: PresetView): PlanConflict[] {
  return tokenPlanConflicts(
    view,
    tokenPlanRecommendation(view, preset, prospectivePlanProvider(view, preset)),
  );
}

type Apply = (change: ModelSettingsChange, basis?: ModelSettingsView) => Promise<ApplyResult>;

/** Assign the plan's recommendation against the view as it is now. */
async function assignRecommendation(
  apply: Apply,
  view: ModelSettingsView,
  preset: PresetView,
  providerId: string,
  mode: PlanApplyMode,
): Promise<Exclude<FirstRunResult, { status: 'failed' }>> {
  const provider = view.providers.find((entry) => entry.id === providerId);
  if (!provider) return { status: 'partial', providerId, reason: 'not-added' };
  const set = tokenPlanAssignments(view, tokenPlanRecommendation(view, preset, provider), mode);
  const assigned = Object.keys(set);
  if (!assigned.length) {
    return isLlmConfigured(view)
      ? { status: 'done', providerId, assigned }
      : { status: 'partial', providerId };
  }
  const filled = await apply({ kind: 'slots', set }, view);
  if (!filled.ok) {
    if (filled.reason === 'unconfirmed' && filled.view && isLlmConfigured(filled.view)) {
      return { status: 'done', providerId, assigned };
    }
    return { status: 'partial', providerId, reason: filled.reason, message: filled.message };
  }
  if (!isLlmConfigured(filled.view)) {
    return { status: 'partial', providerId, reason: 'llm-missing' };
  }
  return { status: 'done', providerId, assigned };
}

/**
 * Connect a plan with a key, or save a new key for a connected one, then
 * apply its recommendation (see {@link tokenPlanAssignments}). A plan saved
 * again re-applies it, as connecting did.
 */
export async function connectTokenPlan(
  apply: Apply,
  view: ModelSettingsView,
  preset: PresetView,
  apiKey: string,
  mode: PlanApplyMode,
): Promise<FirstRunResult> {
  const existing = workspacePlanProvider(view, preset.id);
  const providerId = existing?.id ?? newProviderId(view, preset.id);
  const change: ModelSettingsChange = existing
    ? { kind: 'provider', id: existing.id, preset: existing.preset, apiKey }
    : providerChange(providerId, { ...emptyDraft(preset.id), apiKey }, preset);
  const added = await apply(change, view);
  if (added.ok) return assignRecommendation(apply, added.view, preset, providerId, mode);
  if (added.reason === 'unconfirmed') {
    if (!added.view) {
      return { status: 'partial', providerId, reason: 'unconfirmed-add', message: added.message };
    }
    if (added.view.providers.some((provider) => provider.id === providerId)) {
      return assignRecommendation(apply, added.view, preset, providerId, mode);
    }
  }
  return { status: 'failed', reason: added.reason, message: added.message };
}
