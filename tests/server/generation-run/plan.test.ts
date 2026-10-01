/**
 * The run state machine: which step runs next, in which state, from what is
 * checkpointed; and where a retry returns a paused run.
 */
import { describe, expect, it } from 'vitest';

import {
  advanceRun,
  generationSteps,
  parseStepId,
  phaseOfStep,
  preparationSteps,
  sceneStepId,
  stateForRetry,
} from '@/lib/server/generation/run/plan';

const noMaterials = { materialIds: [] };
const withMaterials = { materialIds: ['mat_00000000000000000000000000'] };

describe('generation run plan', () => {
  it('prepares in the browser order: material analysis only with materials, then research and the outline', () => {
    expect(preparationSteps(noMaterials).map((step) => step.id)).toEqual(['research', 'outline']);
    expect(preparationSteps(withMaterials).map((step) => step.id)).toEqual([
      'material-analysis',
      'research',
      'outline',
    ]);
  });

  it('generates agents, then content → actions → narration → append scene by scene in order', () => {
    expect(generationSteps(2).map((step) => step.id)).toEqual([
      'agents',
      'scene:0:content',
      'scene:0:actions',
      'scene:0:narration',
      'scene:0:append',
      'scene:1:content',
      'scene:1:actions',
      'scene:1:narration',
      'scene:1:append',
    ]);
  });

  it('walks preparing → outlining → awaiting confirmation', () => {
    const completed = new Set<string>();
    const first = advanceRun({
      state: 'preparing',
      runInput: withMaterials,
      completed,
      sceneCount: 0,
    });
    expect(first).toMatchObject({
      kind: 'step',
      step: { id: 'material-analysis' },
      state: 'preparing',
    });
    completed.add('material-analysis');
    expect(
      advanceRun({ state: 'preparing', runInput: withMaterials, completed, sceneCount: 0 }),
    ).toMatchObject({ kind: 'step', step: { id: 'research' }, state: 'preparing' });
    completed.add('research');
    expect(
      advanceRun({ state: 'preparing', runInput: withMaterials, completed, sceneCount: 0 }),
    ).toMatchObject({ kind: 'step', step: { id: 'outline' }, state: 'outlining' });
    completed.add('outline');
    expect(
      advanceRun({ state: 'outlining', runInput: withMaterials, completed, sceneCount: 0 }),
    ).toEqual({ kind: 'await-outline-confirmation' });
  });

  it('resumes a generating run after its last checkpoint, and completes after the last append', () => {
    const completed = new Set(['research', 'outline', 'agents', 'scene:0:content']);
    expect(
      advanceRun({ state: 'generating', runInput: noMaterials, completed, sceneCount: 2 }),
    ).toMatchObject({ kind: 'step', step: { id: 'scene:0:actions', sceneIndex: 0 } });
    for (const step of generationSteps(2)) completed.add(step.id);
    expect(
      advanceRun({ state: 'generating', runInput: noMaterials, completed, sceneCount: 2 }),
    ).toEqual({ kind: 'complete' });
  });

  it('skips content generated ahead and runs the earliest missing step', () => {
    const completed = new Set([
      'research',
      'outline',
      'agents',
      'scene:0:content',
      'scene:0:actions',
      'scene:0:narration',
      'scene:0:append',
      'scene:2:content',
    ]);
    expect(
      advanceRun({ state: 'generating', runInput: noMaterials, completed, sceneCount: 3 }),
    ).toMatchObject({ step: { id: 'scene:1:content' } });
  });

  it('holds no step in the waiting and terminal states', () => {
    for (const state of [
      'awaiting_outline_confirmation',
      'paused',
      'completed',
      'ended',
    ] as const) {
      expect(() =>
        advanceRun({ state, runInput: noMaterials, completed: new Set(), sceneCount: 1 }),
      ).toThrow(/has no step/);
    }
  });

  it('retries a paused step in its own phase', () => {
    expect(stateForRetry('material-analysis')).toBe('preparing');
    expect(stateForRetry('research')).toBe('preparing');
    expect(stateForRetry('outline')).toBe('outlining');
    expect(stateForRetry('agents')).toBe('generating');
    expect(stateForRetry(sceneStepId(3, 'narration'))).toBe('generating');
    expect(() => stateForRetry('scene:x:content')).toThrow(/Unknown run step/);
  });

  it('parses the step ids it produces, and nothing else', () => {
    for (const step of [...preparationSteps(withMaterials), ...generationSteps(2)]) {
      expect(parseStepId(step.id)).toEqual(step);
      expect(phaseOfStep(step)).toBe(stateForRetry(step.id));
    }
    expect(parseStepId('scene:1:render')).toBeNull();
    expect(parseStepId('stage')).toBeNull();
  });
});
