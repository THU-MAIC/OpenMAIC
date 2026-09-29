import { describe, expect, it } from 'vitest';
import {
  MODEL_SLOTS,
  STAGE_SLOTS,
  getSlot,
  isSlotId,
  slotForStage,
  slotLineage,
  type SlotId,
} from '@/lib/config/model-slots';
import { STATION_STAGE_KEYS } from '@/lib/config/station-stage-keys';
import { LLM_STAGES, type LlmStage } from '@/lib/server/model-routes';

const ids = MODEL_SLOTS.map((slot) => slot.id as SlotId);

/**
 * The intended destinations, written out independently of the module under
 * test so that re-pointing any stage fails here.
 */
const EXPECTED_STAGE_SLOTS: Record<LlmStage, SlotId> = {
  'scene-outlines-stream': 'course.outline',
  'scene-content': 'course.content',
  'scene-content:slide': 'course.content.slide',
  'scene-content:quiz': 'course.content.quiz',
  'scene-content:interactive': 'course.content.interactive',
  'scene-content:pbl': 'course.content.pbl',
  'scene-actions': 'course.actions',
  'agent-profiles': 'course.agents',
  'quiz-grade': 'classroom',
  'pbl-chat': 'classroom',
  'pbl-v2-runtime': 'classroom',
  'pbl-v2-runtime:instructor': 'classroom',
  'pbl-v2-runtime:open-task': 'classroom',
  'pbl-v2-runtime:evaluate': 'classroom',
  'pbl-v2-runtime:simulator': 'classroom',
  'chat-adapter': 'classroom',
  'generate-classroom': 'llm',
  'web-search-query-rewrite': 'course.research',
  'maic-agent': 'agent',
  'maic-agent-driver': 'agent',
  'conversation-title': 'agent.title',
};

const EXPECTED_ROOTS = {
  llm: 'chat',
  tts: 'tts',
  asr: 'asr',
  image: 'image',
  video: 'video',
  webSearch: 'webSearch',
  document: 'document',
} as const;

describe('capability slot tree', () => {
  it('has unique slot ids', () => {
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('only references existing parents of the same capability', () => {
    for (const slot of MODEL_SLOTS) {
      if (slot.parent === null) continue;
      expect(isSlotId(slot.parent), `${slot.id} → ${slot.parent}`).toBe(true);
      expect(getSlot(slot.parent as SlotId).capability, slot.id).toBe(slot.capability);
    }
  });

  it('has exactly the expected capability roots', () => {
    const roots = Object.fromEntries(
      MODEL_SLOTS.filter((slot) => slot.parent === null).map((slot) => [slot.id, slot.capability]),
    );
    expect(roots).toEqual(EXPECTED_ROOTS);
  });

  it('ends every lineage at its capability root without cycles', () => {
    for (const id of ids) {
      const lineage = slotLineage(id);
      expect(lineage[0]).toBe(id);
      const root = getSlot(lineage[lineage.length - 1]);
      expect(root.parent, id).toBeNull();
      expect(root.capability).toBe(getSlot(id).capability);
    }
  });

  it('walks the full chain of ancestors', () => {
    expect(slotLineage('course.content.slide')).toEqual([
      'course.content.slide',
      'course.content',
      'llm',
    ]);
    expect(slotLineage('agent.title')).toEqual(['agent.title', 'agent', 'llm']);
    expect(slotLineage('course.outline')).toEqual(['course.outline', 'llm']);
    expect(slotLineage('video')).toEqual(['video']);
  });

  it('names dotted slots after their parent, and top-level chat uses hang off llm', () => {
    for (const slot of MODEL_SLOTS) {
      if (slot.parent === null) continue;
      const dot = slot.id.lastIndexOf('.');
      const prefix = slot.id.slice(0, dot);
      if (isSlotId(prefix)) {
        expect(slot.parent, slot.id).toBe(prefix);
      } else {
        expect(slot.parent, slot.id).toBe('llm');
      }
    }
  });

  it('does not pass requirements down to child slots', () => {
    expect(getSlot('agent').requires).toEqual(['toolCalling']);
    expect(getSlot('agent.title').requires).toBeUndefined();
  });

  it('keeps agent.title out of the settings UI', () => {
    expect(getSlot('agent.title').configOnly).toBe(true);
    const shown = MODEL_SLOTS.filter((slot) => 'configOnly' in slot && slot.configOnly);
    expect(shown.map((slot) => slot.id)).toEqual(['agent.title']);
  });
});

describe('stage → slot mapping', () => {
  it('maps every LLM stage, and nothing else', () => {
    expect(Object.keys(STAGE_SLOTS).sort()).toEqual([...LLM_STAGES].sort());
  });

  it('sends every stage to its intended slot', () => {
    expect(STAGE_SLOTS).toEqual(EXPECTED_STAGE_SLOTS);
    for (const [stage, slot] of Object.entries(EXPECTED_STAGE_SLOTS)) {
      expect(slotForStage(stage as LlmStage), stage).toBe(slot);
    }
  });

  it('maps every stage to a chat slot', () => {
    for (const stage of LLM_STAGES) {
      const slot = slotForStage(stage);
      expect(isSlotId(slot), stage).toBe(true);
      expect(getSlot(slot).capability, stage).toBe('chat');
    }
  });

  it('gives each scene type its own child of course.content', () => {
    for (const stage of LLM_STAGES) {
      const match = /^scene-content:(.+)$/.exec(stage);
      if (!match) continue;
      expect(slotForStage(stage)).toBe(`course.content.${match[1]}`);
      expect(getSlot(slotForStage(stage)).parent).toBe('course.content');
    }
  });

  it('keeps every stage of a settings station on one slot', () => {
    for (const [station, stages] of Object.entries(STATION_STAGE_KEYS)) {
      const slots = new Set(stages.map((stage) => slotForStage(stage as LlmStage)));
      expect(slots.size, station).toBe(1);
    }
  });
});
