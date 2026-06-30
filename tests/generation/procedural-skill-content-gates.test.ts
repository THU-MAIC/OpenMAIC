import { describe, expect, test } from 'vitest';

import { applyOutlineFallbacks } from '@/lib/generation/outline-generator';
import type { SceneOutline } from '@/lib/types/generation';

describe('procedural-skill content gates', () => {
  test('applyOutlineFallbacks strips procedural-skill when vocational mode is not active', () => {
    const outline = createProceduralSkillOutline();
    const safeOutline = applyOutlineFallbacks(outline, true);

    expect(safeOutline.widgetType).toBe('diagram');
    expect(safeOutline.widgetOutline?.procedureType).toBeUndefined();
    expect(safeOutline.widgetOutline?.task).toBeUndefined();
    expect(safeOutline.widgetOutline?.errorConsequences).toBeUndefined();
  });

  test('applyOutlineFallbacks retains procedural-skill only when explicitly allowed', () => {
    const outline = createProceduralSkillOutline();
    const safeOutline = applyOutlineFallbacks(outline, true, { allowProceduralSkill: true });

    expect(safeOutline.widgetType).toBe('procedural-skill');
    expect(safeOutline.widgetOutline?.errorConsequences).toEqual([
      'Unsafe readings require stopping and rechecking',
    ]);
  });
});

function createProceduralSkillOutline(): SceneOutline {
  return {
    id: 'scene-procedural-skill',
    type: 'interactive',
    title: 'Device Calibration Practice',
    description: 'Practice a generic calibration procedure with step feedback.',
    keyPoints: ['Follow steps in order', 'Check each success criterion'],
    order: 1,
    widgetType: 'procedural-skill',
    widgetOutline: {
      concept: 'calibration procedure',
      procedureType: 'operation',
      task: 'Calibrate a training device',
      tools: ['multimeter', 'checklist'],
      steps: ['Inspect the device', 'Connect the tool', 'Confirm the reading'],
      successCriteria: ['No visible damage', 'Reading is within range'],
      errorConsequences: ['Unsafe readings require stopping and rechecking'],
    },
  };
}
