/**
 * What the model settings show, derived in one place from the server's view
 * (RFC #1701, "What the settings show"). One rule decides every control:
 * render it only if using it can change something. Users never see slots,
 * locks or policies as concepts; the settings take one of three shapes:
 *
 * - `yourself` (set it up yourself): users may add keys (`allowUserKeys`), so
 *   Token Plan, Model Services and the course model map, each where it can
 *   still change a slot;
 * - `choose` (choose a model): no keys of their own, so only the course model
 *   map, choosing among the deployment's providers;
 * - `admin` (configured by the administrator): nothing a user may set, so
 *   the course model map with every card read-only.
 *
 * Pure functions over the view; every component asks these instead of
 * checking locks or the deployment's switches itself.
 */
import type { SlotCapability } from '@/lib/config/model-slots';

import type { ModelSettingsView, PresetView, SlotView } from './client';
import { sameAssignment } from './edit';

export type SettingsShape = 'yourself' | 'choose' | 'admin';

/** The capabilities Model Services has a tab for, in its order. */
export const SERVICE_CAPABILITIES: readonly SlotCapability[] = [
  'chat',
  'image',
  'video',
  'tts',
  'asr',
  'document',
  'webSearch',
];

/** Whether a user may set this slot: shown in the settings and not in a locked subtree. */
export function slotEditable(slot: SlotView | undefined): slot is SlotView {
  return !!slot && !slot.locked && !slot.configOnly;
}

/**
 * Whether the default model (the `llm` root) can be changed: it is not locked
 * and some provider offers a language model to pick. The home page's model
 * picker, a shortcut for it, appears only then.
 */
export function canChangeDefaultModel(view: ModelSettingsView): boolean {
  return (
    slotEditable(view.slots.find((slot) => slot.slot === 'llm')) &&
    view.providers.some((provider) => !!provider.capabilities.chat)
  );
}

/** Whether some slot of a capability can still be set. */
export function capabilityEditable(view: ModelSettingsView, capability: SlotCapability): boolean {
  return view.slots.some((slot) => slot.capability === capability && slotEditable(slot));
}

/**
 * Whether adding a service for a capability can change anything: users may
 * add keys, a preset offers the capability, and some slot of it can be set.
 */
export function canAddService(view: ModelSettingsView, capability: SlotCapability): boolean {
  return (
    view.allowUserKeys &&
    capabilityEditable(view, capability) &&
    view.presets.some((preset) => !!preset.capabilities[capability])
  );
}

/**
 * The slots connecting a plan may fill: the ones it recommends, and `llm`
 * when it serves chat (connecting sets the default model at least).
 */
function planSlots(preset: PresetView): string[] {
  const slots = Object.keys(preset.recommended);
  return preset.capabilities.chat && !slots.includes('llm') ? [...slots, 'llm'] : slots;
}

/**
 * Whether connecting a token plan can change anything: users may add keys and
 * at least one slot the plan would fill is not locked (connecting never
 * touches a locked one).
 */
/**
 * Whether Token Plan lists a plan: connecting it can change something, or
 * the workspace connected it already (its key can still be replaced or the
 * plan disconnected, whatever is locked since).
 */
export function tokenPlanListed(view: ModelSettingsView, preset: PresetView): boolean {
  if (!view.allowUserKeys) return false;
  return (
    tokenPlanCanChange(view, preset) ||
    view.providers.some(
      (provider) => provider.source === 'workspace' && provider.preset === preset.id,
    )
  );
}

export function tokenPlanCanChange(view: ModelSettingsView, preset: PresetView): boolean {
  if (!view.allowUserKeys) return false;
  const slots = new Map<string, SlotView>(view.slots.map((slot) => [slot.slot, slot]));
  return planSlots(preset).some((id) => slotEditable(slots.get(id)));
}

/** Narration services with voices a user manages in the settings (designed or cloned). */
const USER_VOICE_SERVICES: readonly string[] = ['voxcpm-tts', 'qwen-tts'];

/**
 * Whether the narration the workspace uses has voices of the user's own to
 * manage (VoxCPM designs, Qwen clones): the Text-to-Speech tab is shown for
 * them whatever else can change.
 */
export function narrationVoicesManageable(view: ModelSettingsView): boolean {
  const tts = view.slots.find((slot) => slot.slot === 'tts')?.effective;
  return tts?.status === 'assigned' && USER_VOICE_SERVICES.includes(tts.registryId);
}

export function settingsShape(view: ModelSettingsView): SettingsShape {
  if (!view.slots.some(slotEditable)) return 'admin';
  return view.allowUserKeys ? 'yourself' : 'choose';
}

export interface SettingsSections {
  shape: SettingsShape;
  /**
   * Token Plan: some plan can still fill a slot, or one the workspace connected
   * is there to manage. Never shown when everything is locked.
   */
  tokenPlan: boolean;
  /**
   * Model Services, with the capabilities whose tab is shown: adding a service
   * there can change something, or (Text-to-Speech) the narration in use has
   * voices of the user's own to manage. Empty when everything is locked.
   */
  modelServices: readonly SlotCapability[];
}

export function settingsSections(view: ModelSettingsView): SettingsSections {
  const shape = settingsShape(view);
  // Configured by the administrator: only the read-only course model map. A
  // plan the workspace connected earlier no longer changes anything, and
  // narration voices are not managed here in this shape.
  if (shape === 'admin') return { shape, tokenPlan: false, modelServices: [] };
  const yourself = shape === 'yourself';
  return {
    shape,
    tokenPlan: view.presets.some(
      (preset) => preset.kind === 'token-plan' && tokenPlanListed(view, preset),
    ),
    modelServices: SERVICE_CAPABILITIES.filter(
      (capability) =>
        (yourself && canAddService(view, capability)) ||
        (capability === 'tts' && narrationVoicesManageable(view)),
    ),
  };
}

/**
 * Whether a slot's card may offer "Reset to server default": the workspace
 * set it to something other than the default the deployment writes on the
 * slot itself.
 */
export function canResetToServerDefault(slot: SlotView): boolean {
  return (
    slotEditable(slot) &&
    slot.assignment !== undefined &&
    slot.serverDefault !== undefined &&
    !sameAssignment(slot.assignment, slot.serverDefault)
  );
}

/**
 * Whether dropping a slot's own assignment brings back the server default on
 * it: the deployment writes one there and the workspace sets nothing above
 * the slot (a choice up the tree beats the default). Otherwise the default
 * has to be written as the slot's own assignment to use it.
 */
export function clearingRestoresDefault(view: ModelSettingsView, slot: SlotView): boolean {
  if (slot.serverDefault === undefined) return false;
  const slots = new Map<string, SlotView>(view.slots.map((entry) => [entry.slot, entry]));
  for (let parent = slot.parent; parent; parent = slots.get(parent)?.parent ?? null) {
    if (slots.get(parent)?.assignment !== undefined) return false;
  }
  return true;
}
