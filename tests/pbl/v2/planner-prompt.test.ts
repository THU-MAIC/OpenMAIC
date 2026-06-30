/**
 * Guard tests for the planner-system prompt — the instructor `description`
 * field must be specified as a SHORT, learner-facing avatar-hover intro that
 * does NOT leak internal mechanics. Locks the spec so it can't silently
 * regress. (Model compliance is an eval/manual concern; this only guarantees
 * the instruction is present in the prompt the planner receives.)
 */
import { describe, expect, it } from 'vitest';
import { loadPBLV2Prompt } from '@/lib/pbl/v2/prompts/loader';

describe('planner-system prompt — instructor learner-facing intro spec', () => {
  const prompt = loadPBLV2Prompt('planner-system');
  const singleCallPrompt = loadPBLV2Prompt('planner-single-call-system');

  it('specifies description as a short learner-facing avatar-hover intro', () => {
    expect(prompt).toContain('learner-facing introduction');
    expect(prompt).toMatch(/hover/i);
    expect(prompt).toContain('2-3 short sentences');
  });

  it('forbids exposing internal mechanics in the learner-facing intro', () => {
    expect(prompt).toContain('Do **NOT** expose internal mechanics');
  });

  it('keeps systemPrompt as the internal, not-shown persona', () => {
    expect(prompt).toContain('NOT shown to the learner');
  });

  it('specifies a descriptive guide-title name, NOT a personal human name', () => {
    // Guards the regression where the instructor was named e.g. "林岚" instead
    // of a topic-tied guide title like "排序项目教练".
    expect(prompt).toContain('descriptive guide title tied to THIS project');
    expect(prompt).toContain('do **NOT** invent a personal human name');
  });

  it('locks ordinary PBL to visible text instead of hidden resources', () => {
    for (const text of [prompt, singleCallPrompt]) {
      expect(text).toContain('Actual ordinary PBL workspace');
      expect(text).toContain('does **NOT** provide a right-side briefing tab');
      expect(text).toContain('Do NOT mention a right-side briefing');
      expect(text).not.toContain('add_document');
    }
    expect(prompt).toContain('No hidden resources');
    expect(singleCallPrompt).not.toContain('`documents`');
  });

  it('hardens the single-call prompt against worksheet fragmentation and answer leakage', () => {
    expect(singleCallPrompt).toContain('Worksheet fragmentation');
    expect(singleCallPrompt).toContain('trivial mechanics-only microtask');
    expect(singleCallPrompt).toContain('exact method name');
    expect(singleCallPrompt).toContain('near-copyable code fragment');
  });

  it('hardens the single-call prompt against fake deliverables and prose-only software tasks', () => {
    expect(singleCallPrompt).toContain('never de-grade a build into prose-only work');
    expect(singleCallPrompt).toContain('could be completed by prose alone');
    expect(singleCallPrompt).toContain('build/test/debug/revise the actual artifact');
    expect(singleCallPrompt).toContain('strong-vs-weak criteria');
  });
});
