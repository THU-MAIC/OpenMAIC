import { describe, expect, test } from 'vitest';

import { buildPrompt, PROMPT_IDS } from '@/lib/prompts';

const UNRESOLVED_PLACEHOLDER = /\{\{[^}]+\}\}/;

function combined(prompt: { system: string; user: string } | null) {
  expect(prompt).not.toBeNull();
  return `${prompt!.system}
${prompt!.user}`;
}

function buildProceduralSkillPrompt() {
  return combined(
    buildPrompt(PROMPT_IDS.PROCEDURAL_SKILL_CONTENT, {
      title: 'Device Inspection Practice',
      procedureType: 'inspection',
      task: 'Inspect a training device and decide whether it is safe to operate',
      description: 'Practice a generic inspection procedure with measurement and status feedback.',
      keyPoints: `1. Select the right tool
2. Check the threshold
3. Recheck unsafe conditions`,
      tools: ['inspection checklist', 'multimeter', 'protective gloves'],
      steps: ['Select the tool', 'Measure voltage', 'Judge safe or unsafe'],
      successCriteria: ['All checks completed', 'Unsafe conditions identified'],
      errorConsequences: ['Unsafe readings require stopping and rechecking'],
      languageDirective: 'Teach in English.',
    }),
  );
}

describe('procedural-skill content quality contract', () => {
  test('defines procedural-skill as procedural practice rather than a checklist', () => {
    const text = buildProceduralSkillPrompt();

    expect(text).toMatch(/not a checklist/i);
    expect(text).toMatch(/Clicking Done cannot be the only meaningful interaction/i);
    expect(text).toMatch(/Procedural practice/i);
    expect(text).not.toMatch(UNRESOLVED_PLACEHOLDER);
  });

  test('requires decision, state, operation proxy, and consequence feedback semantics', () => {
    const text = buildProceduralSkillPrompt();

    expect(text).toMatch(/decision/i);
    expect(text).toMatch(/judgment/i);
    expect(text).toMatch(/state\/?status panel|state panel|status panel/i);
    expect(text).toMatch(/measurement/i);
    expect(text).toMatch(/threshold/i);
    expect(text).toMatch(/operation proxy/i);
    expect(text).toMatch(/consequence feedback/i);
    expect(text).toContain('Unsafe readings require stopping and rechecking');
    expect(text).toMatch(/risk detected|unsafe state|requires recheck|inspection blocked/i);
  });

  test('allows visual variety while preserving procedural training behavior', () => {
    const text = buildProceduralSkillPrompt();

    expect(text).toMatch(/training mechanism[\s\S]{0,100}not a fixed visual style/i);
    expect(text).toMatch(/dark dashboard|checklist panel/i);
    expect(text).toMatch(/Choose a layout that fits|visual layout that fits/i);
    expect(text).toMatch(
      /light step-card board|work-order desk|safety inspection station|measurement station|process kanban|simulator-like control board|GO\/STOP decision station/i,
    );
    expect(text).toMatch(/task operation/i);
    expect(text).toMatch(/decision/i);
    expect(text).toMatch(/feedback/i);
    expect(text).toMatch(/progress/i);
    expect(text).toMatch(/reset/i);
    expect(text).toMatch(/completion checking/i);
    expect(text).toContain('#task-panel');
    expect(text).toContain('#feedback-panel');
    expect(text).toContain('event.data.type');
    expect(text).not.toMatch(UNRESOLVED_PLACEHOLDER);
  });

  test('requires success criteria to be gated by actual state', () => {
    const text = buildProceduralSkillPrompt();

    expect(text).toMatch(/Success Criteria Gating/i);
    expect(text).toMatch(/must not appear completed until/i);
    expect(text).toMatch(/All checks completed/i);
    expect(text).toMatch(/1 of N/i);
    expect(text).toMatch(/actual state/i);
  });

  test('requires visible clickable controls and mandatory feedback panel', () => {
    const text = buildProceduralSkillPrompt();

    expect(text).toMatch(/visible[\s\S]{0,80}enabled[\s\S]{0,80}clickable/i);
    expect(text).toContain('#step-1-control');
    expect(text).toMatch(/empty controls|empty control/i);
    expect(text).toMatch(/empty div/i);
    expect(text).toContain('#feedback-panel');
    expect(text).toMatch(
      /#state-panel[\s\S]{0,120}(cannot replace|replace)[\s\S]{0,120}#feedback-panel/i,
    );
    expect(text).toMatch(
      /reset button[\s\S]{0,120}visible[\s\S]{0,120}enabled[\s\S]{0,120}clickable/i,
    );
    expect(text).toMatch(/progress[\s\S]{0,120}feedback|feedback[\s\S]{0,120}progress/i);
    expect(text).not.toMatch(UNRESOLVED_PLACEHOLDER);
  });

  test('requires reset and SET_WIDGET_STATE to synchronize visible runtime state safely', () => {
    const text = buildProceduralSkillPrompt();

    expect(text).toMatch(/resetState|full reset path|reset path/i);
    expect(text).toMatch(/restore[\s\S]{0,120}progress[\s\S]{0,120}feedback/i);
    expect(text).toMatch(
      /success criteria[\s\S]{0,120}pending|pending[\s\S]{0,120}success criteria/i,
    );
    expect(text).toContain('completedSteps');
    expect(text).toMatch(/SET_WIDGET_STATE[\s\S]{0,160}(progress|visible UI|re-render|render)/i);
    expect(text).toMatch(/shared[\s\S]{0,80}(render|update)|same[\s\S]{0,80}(render|update)/i);
    expect(text).toMatch(/null-safe|document\.querySelector|if \(!el\) return|missing elements/i);
    expect(text).toMatch(
      /disabled[\s\S]{0,120}textContent[\s\S]{0,120}className|textContent[\s\S]{0,120}className[\s\S]{0,120}style/i,
    );
    expect(text).toContain('event.data.type');
    expect(text).toContain('data.state');
    expect(text).toContain('data.target');
    expect(text).toContain('#feedback-panel');
    expect(text).toContain('#progress-display');
    expect(text).toContain('#reset-btn');
    expect(text).not.toMatch(UNRESOLVED_PLACEHOLDER);
  });

  test('preserves stable teacher-action selectors and existing message types', () => {
    const text = buildProceduralSkillPrompt();

    expect(text).toContain('#task-panel');
    expect(text).toContain('#tool-list');
    expect(text).toContain('#step-list');
    expect(text).toContain('[data-step-id="step-1"]');
    expect(text).toContain('#step-1-control');
    expect(text).toContain('#progress-display');
    expect(text).toContain('#reset-btn');
    expect(text).toContain('#success-criteria');
    expect(text).toContain('#feedback-panel');
    expect(text).toContain('SET_WIDGET_STATE');
    expect(text).toContain('HIGHLIGHT_ELEMENT');
    expect(text).toContain('ANNOTATE_ELEMENT');
    expect(text).toContain('REVEAL_ELEMENT');
    expect(text).toContain('event.data.type');
    expect(text).not.toContain('event.data.type || event.data.action');
    expect(text).toContain('data.state');
    expect(text).toContain('data.target');
    expect(text).toMatch(/platform message field|renderer sends/i);
    expect(text).not.toMatch(UNRESOLVED_PLACEHOLDER);
  });
});
