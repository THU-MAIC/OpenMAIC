/**
 * Which language model stages do not use the default model (the `llm` root),
 * read from the server's view. The home toolbar picker sets only the default,
 * so it says when some stages have their own model, and when every stage a
 * course is generated with does (picking a default then changes nothing for
 * course generation).
 */
import type { SlotId } from '@/lib/config/model-slots';

import type { ModelSettingsView, SlotView } from './client';

/** A stage set separately: its own setting resolves to something other than the default. */
export interface OverriddenStage {
  slot: SlotId;
  parent: SlotId | null;
  /** What the stage resolves to: a model, or off. */
  target: { kind: 'model'; providerId: string; modelId?: string } | { kind: 'off' };
}

/**
 * The stages every course is generated with: the outline, the content of each
 * page type and the teacher's actions. The other course stages run only on
 * request (the agent roster when agents are generated, the search query
 * rewrite when web search is on), so they are left out, as
 * `courseGenerationUsable` leaves them out.
 *
 * The page types are listed rather than `course.content`: each page resolves
 * its own type's slot, so the content default is used only by the types that
 * follow it.
 */
export const COURSE_GENERATION_STAGES: readonly SlotId[] = [
  'course.outline',
  'course.content.slide',
  'course.content.quiz',
  'course.content.interactive',
  'course.content.pbl',
  'course.actions',
];

function slotsById(view: ModelSettingsView): Map<string, SlotView> {
  return new Map(view.slots.map((slot) => [slot.slot, slot]));
}

/**
 * Whether a slot keeps its own model when the default changes: the
 * workspace's own choice on it, or a lock. A server default on the slot is
 * no barrier: the workspace's choice on `llm` overrides it (the user's choice
 * anywhere up the tree beats a server default).
 */
function keepsOwnModel(slot: SlotView): boolean {
  return slot.assignment !== undefined || slot.locked;
}

/**
 * Whether a slot follows the default model: nothing between it and `llm`
 * keeps a model of its own, so it takes whatever the default becomes.
 */
export function followsDefault(view: ModelSettingsView, slotId: string): boolean {
  const slots = slotsById(view);
  let current = slots.get(slotId);
  while (current) {
    if (current.slot === 'llm') return true;
    if (keepsOwnModel(current)) return false;
    current = current.parent ? slots.get(current.parent) : undefined;
  }
  return false;
}

/** Whether a slot is under `llm`. */
function underDefault(slots: Map<string, SlotView>, slot: SlotView): boolean {
  let parent = slot.parent ? slots.get(slot.parent) : undefined;
  while (parent) {
    if (parent.slot === 'llm') return true;
    parent = parent.parent ? slots.get(parent.parent) : undefined;
  }
  return false;
}

/** A comparable key for what a slot resolves to. */
function resolvedKey(slot: SlotView | undefined): string {
  const effective = slot?.effective;
  if (!effective) return 'none';
  if (effective.status === 'assigned')
    return `model:${effective.providerId}:${effective.modelId ?? ''}`;
  if (effective.status === 'disabled') return 'off';
  return effective.status;
}

/**
 * The stages under `llm` set separately: each keeps a model of its own when
 * the default changes (the workspace's choice on it, or a lock on it) and
 * resolves to something other than the default. A stage that inherits, one
 * on a server default (choosing a default replaces it), one set to the same
 * model as the default, and a slot shown only in configuration files are
 * not. Listed in the view's slot order.
 */
export function defaultModelOverrides(view: ModelSettingsView | null): OverriddenStage[] {
  if (!view) return [];
  const slots = slotsById(view);
  const defaultKey = resolvedKey(slots.get('llm'));
  const overridden: OverriddenStage[] = [];
  for (const slot of view.slots) {
    if (slot.configOnly || slot.slot === 'llm' || !underDefault(slots, slot)) continue;
    const own =
      (slot.assignment !== undefined && slot.source.kind === 'workspace') ||
      slot.source.kind === 'locked';
    if (!own || resolvedKey(slot) === defaultKey) continue;
    const effective = slot.effective;
    if (effective.status === 'assigned') {
      overridden.push({
        slot: slot.slot,
        parent: slot.parent,
        target: {
          kind: 'model',
          providerId: effective.providerId,
          ...(effective.modelId ? { modelId: effective.modelId } : {}),
        },
      });
    } else if (effective.status === 'disabled') {
      overridden.push({ slot: slot.slot, parent: slot.parent, target: { kind: 'off' } });
    }
  }
  return overridden;
}

/**
 * Whether no stage a course is generated with follows the default model:
 * every one of {@link COURSE_GENERATION_STAGES} has a setting of its own (or
 * follows one), and at least one stage resolves to something other than the
 * default. Picking a default then does not change how courses are generated.
 */
export function courseStagesAllOverridden(view: ModelSettingsView | null): boolean {
  if (!view) return false;
  const slots = slotsById(view);
  const listed = COURSE_GENERATION_STAGES.filter((slot) => slots.has(slot));
  if (listed.length === 0) return false;
  if (listed.some((slot) => followsDefault(view, slot))) return false;
  return defaultModelOverrides(view).length > 0;
}

/**
 * The Token Plan every course generation stage resolves to, when they all
 * resolve to one provider made from a plan; undefined otherwise.
 */
export function courseStagesPlanName(view: ModelSettingsView | null): string | undefined {
  if (!view) return undefined;
  const slots = slotsById(view);
  const providers = new Set<string>();
  for (const id of COURSE_GENERATION_STAGES) {
    const effective = slots.get(id)?.effective;
    if (!effective) continue;
    if (effective.status !== 'assigned') return undefined;
    providers.add(effective.providerId);
  }
  if (providers.size !== 1) return undefined;
  const provider = view.providers.find((entry) => entry.id === [...providers][0]);
  return provider?.presetKind === 'token-plan' ? provider.presetName : undefined;
}
