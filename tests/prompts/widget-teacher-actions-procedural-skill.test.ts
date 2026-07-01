import { describe, expect, test } from 'vitest';

import { buildPrompt, PROMPT_IDS } from '@/lib/prompts';

const UNRESOLVED_PLACEHOLDER = /\{\{[^}]+\}\}/;

function combined(prompt: { system: string; user: string } | null) {
  expect(prompt).not.toBeNull();
  return `${prompt!.system}\n${prompt!.user}`;
}

describe('procedural-skill widget action selector contract', () => {
  test('interactive-actions prompt documents procedural-skill stable widget action targets', () => {
    const text = combined(
      buildPrompt(PROMPT_IDS.INTERACTIVE_ACTIONS, {
        title: 'Device Inspection Practice',
        conceptName: 'Device inspection',
        widgetType: 'procedural-skill',
        description: 'Practice a generic inspection procedure.',
        keyPoints: '1. Follow ordered steps\n2. Check completion criteria',
        designIdea: 'A procedural practice widget with step controls and progress feedback.',
        widgetConfig: JSON.stringify({
          type: 'procedural-skill',
          task: 'Inspect a training device',
          steps: [{ id: 'step-1', title: 'Inspect visible condition' }],
          successCriteria: ['Device is ready for use'],
        }),
        courseContext: '',
        agents: '',
        languageDirective: 'Teach in English.',
      }),
    );

    expect(text).toContain('procedural-skill');
    expect(text).toContain('[data-step-id="step-1"]');
    expect(text).toContain('#step-1-control');
    expect(text).toContain('#progress-display');
    expect(text).toContain('#reset-btn');
    expect(text).toContain('completedSteps');
    expect(text).toContain('widget_highlight');
    expect(text).toContain('widget_annotation');
    expect(text).toContain('widget_reveal');
    expect(text).toContain('widget_setState');
    expect(text).not.toMatch(UNRESOLVED_PLACEHOLDER);
  });

  test('interactive-actions prompt documents stable targets for diagram, game, and visualization3d, and forbids guessing', () => {
    const text = combined(
      buildPrompt(PROMPT_IDS.INTERACTIVE_ACTIONS, {
        title: 'Orbit Explorer',
        conceptName: 'Orbital mechanics',
        widgetType: 'visualization3d',
        description: 'Explore a 3D orbit.',
        keyPoints: '1. Observe the orbit',
        designIdea: 'A 3D visualization with zoom and speed controls.',
        widgetConfig: JSON.stringify({ type: 'visualization3d' }),
        courseContext: '',
        agents: '',
        languageDirective: 'Teach in English.',
      }),
    );

    // diagram: node ids from config
    expect(text).toContain('diagram');
    expect(text).toContain('revealOrder');
    // visualization3d canonical controls
    expect(text).toContain('#zoom-in-btn');
    expect(text).toContain('#canvas-container');
    // game
    expect(text).toContain('#start-btn');
    // conservative no-guess rule (covers code widgets with no stable selectors)
    expect(text).toContain('instead of guessing');
    expect(text).not.toMatch(UNRESOLVED_PLACEHOLDER);
  });

  test('procedural-skill content prompt exposes matching teacher-action targets', () => {
    const text = combined(
      buildPrompt(PROMPT_IDS.PROCEDURAL_SKILL_CONTENT, {
        title: 'Device Inspection Practice',
        procedureType: 'inspection',
        task: 'Inspect a training device',
        description: 'Practice a generic inspection procedure.',
        keyPoints: '1. Follow ordered steps\n2. Check completion criteria',
        tools: ['checklist'],
        steps: ['Inspect visible condition'],
        successCriteria: ['Device is ready for use'],
        errorConsequences: ['Unsafe state requires recheck'],
        languageDirective: 'Teach in English.',
      }),
    );

    expect(text).toContain('[data-step-id="step-1"]');
    expect(text).toContain('#step-1-control');
    expect(text).toContain('#progress-display');
    expect(text).toContain('#reset-btn');
    expect(text).toContain('completedSteps');
    expect(text).not.toMatch(UNRESOLVED_PLACEHOLDER);
  });
});
