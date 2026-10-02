/**
 * Capability slots (RFC #1701, tracked in #1725).
 *
 * A slot is a product use that needs AI. Slots form a forest with one tree per
 * capability; each root is the default for its capability. A slot without an
 * assignment inherits from its parent at resolution time, so a parent's value
 * is the default for its whole subtree.
 *
 * Stage keys (`LLM_STAGES`) are call-site labels. They stay internal: every
 * stage maps to exactly one slot through {@link STAGE_SLOTS}, and only slots
 * appear in configuration and the settings UI. The test for whether a use gets
 * its own slot is whether a user would switch models for that use on its own;
 * purely technical splits (the PBL runtime endpoints, the classroom director)
 * fold into an existing slot.
 *
 * This module is pure data and safe to import from client and server code.
 */
import type { LlmStage } from '@/lib/server/model-routes';

export type SlotCapability = 'chat' | 'tts' | 'asr' | 'image' | 'video' | 'webSearch' | 'document';

/** A property the resolved model must have for the slot to be usable. */
export type SlotRequirement = 'toolCalling';

export interface SlotDefinition {
  id: string;
  capability: SlotCapability;
  /** `null` for a capability root. */
  parent: string | null;
  /**
   * Requirements checked against the model this slot resolves to, whether it
   * is assigned here or inherited. They are not passed down to child slots: a
   * child declares its own (`agent.title` needs no tool calling even though
   * `agent` does).
   */
  requires?: readonly SlotRequirement[];
  /** Configurable in `openmaic.yml` only; the settings UI does not show it. */
  configOnly?: boolean;
}

export const MODEL_SLOTS = [
  { id: 'llm', capability: 'chat', parent: null },
  { id: 'course.research', capability: 'chat', parent: 'llm' },
  { id: 'course.outline', capability: 'chat', parent: 'llm' },
  { id: 'course.agents', capability: 'chat', parent: 'llm' },
  { id: 'course.content', capability: 'chat', parent: 'llm' },
  { id: 'course.content.slide', capability: 'chat', parent: 'course.content' },
  { id: 'course.content.quiz', capability: 'chat', parent: 'course.content' },
  { id: 'course.content.interactive', capability: 'chat', parent: 'course.content' },
  { id: 'course.content.pbl', capability: 'chat', parent: 'course.content' },
  { id: 'course.actions', capability: 'chat', parent: 'llm' },
  { id: 'classroom', capability: 'chat', parent: 'llm' },
  { id: 'agent', capability: 'chat', parent: 'llm', requires: ['toolCalling'] },
  { id: 'agent.title', capability: 'chat', parent: 'agent', configOnly: true },
  { id: 'tts', capability: 'tts', parent: null },
  { id: 'asr', capability: 'asr', parent: null },
  { id: 'image', capability: 'image', parent: null },
  { id: 'video', capability: 'video', parent: null },
  { id: 'webSearch', capability: 'webSearch', parent: null },
  { id: 'document', capability: 'document', parent: null },
] as const satisfies readonly SlotDefinition[];

export type SlotId = (typeof MODEL_SLOTS)[number]['id'];

/**
 * Every LLM stage key and the one slot it resolves through.
 *
 * No stage resolves through the `llm` root itself: every slot without a model
 * of its own inherits it. `maic-agent-driver` belongs to `agent`, which the
 * agent runtime resolves directly.
 */
export const STAGE_SLOTS = {
  'scene-outlines-stream': 'course.outline',
  'scene-content': 'course.content',
  'scene-content:slide': 'course.content.slide',
  'scene-content:quiz': 'course.content.quiz',
  'scene-content:interactive': 'course.content.interactive',
  'scene-content:pbl': 'course.content.pbl',
  'scene-actions': 'course.actions',
  'agent-profiles': 'course.agents',
  'quiz-grade': 'classroom',
  'pbl-v2-runtime': 'classroom',
  'pbl-v2-runtime:instructor': 'classroom',
  'pbl-v2-runtime:open-task': 'classroom',
  'pbl-v2-runtime:evaluate': 'classroom',
  'pbl-v2-runtime:simulator': 'classroom',
  'chat-adapter': 'classroom',
  'web-search-query-rewrite': 'course.research',
  'maic-agent-driver': 'agent',
  'conversation-title': 'agent.title',
} as const satisfies Record<LlmStage, SlotId>;

const SLOT_BY_ID = new Map<string, SlotDefinition>(MODEL_SLOTS.map((slot) => [slot.id, slot]));

export function getSlot(id: SlotId): SlotDefinition {
  const slot = SLOT_BY_ID.get(id);
  if (!slot) throw new Error(`Unknown capability slot "${id}"`);
  return slot;
}

export function isSlotId(value: string): value is SlotId {
  return SLOT_BY_ID.has(value);
}

/** The slot itself followed by its ancestors, ending at the capability root. */
export function slotLineage(id: SlotId): SlotId[] {
  const lineage: SlotId[] = [];
  let current: string | null = id;
  while (current !== null) {
    const slot = SLOT_BY_ID.get(current);
    if (!slot) throw new Error(`Unknown capability slot "${current}"`);
    if (lineage.includes(slot.id as SlotId)) {
      throw new Error(`Capability slot cycle at "${slot.id}"`);
    }
    lineage.push(slot.id as SlotId);
    current = slot.parent;
  }
  return lineage;
}

export function slotForStage(stage: LlmStage): SlotId {
  return STAGE_SLOTS[stage];
}
