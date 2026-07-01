import { describe, expect, test } from 'vitest';

import { buildPrompt, PROMPT_IDS } from '@/lib/prompts';

function buildTaskEnginePrompt() {
  const prompt = buildPrompt(PROMPT_IDS.TASK_ENGINE_OUTLINES, {
    requirement: 'NEV-A12 新能源车动力电池包更换前安全确认',
    pdfContent: 'None',
    availableImages: 'No images available',
    researchContext: 'None',
    teacherContext: '',
    userProfile: '',
  });
  expect(prompt).not.toBeNull();
  return `${prompt!.system}\n${prompt!.user}`;
}

describe('task-engine outlines prompt', () => {
  test('adds a suitability gate and non-vocational fallback', () => {
    const text = buildTaskEnginePrompt();

    expect(text).toMatch(/Suitability Gate|suitability gate/i);
    expect(text).toMatch(/vocational procedural task/i);
    expect(text).toMatch(/operation flow/i);
    expect(text).toMatch(/GO\/STOP|safe\/unsafe/i);
    expect(text).toMatch(/safety boundaries|safety boundary/i);
    expect(text).toMatch(/not suitable/i);
    expect(text).toMatch(/fall back|fallback/i);
    expect(text).toMatch(/normal MAIC-style outline/i);
    expect(text).toMatch(/do not (force|use|output).*procedural-skill/i);
    expect(text).toMatch(/Pythagorean theorem|Newton's second law|analyzing a poem/i);
    expect(text).not.toContain('{{');
  });

  test('defines a mixed task-engine outline structure', () => {
    const text = buildTaskEnginePrompt();

    expect(text).toContain('Task Engine');
    expect(text).toContain('10-14 scenes');
    expect(text).toContain('at least 10');
    expect(text).toContain('no more than 14');
    expect(text).toMatch(/mixed structure|mixed vocational/i);
    expect(text).toMatch(/5-7 .*procedural-skill|5-7 .*checklist/i);
    expect(text).toMatch(/2-4 .*explanation|2-4 .*slide/i);
    expect(text).toMatch(/2-4 .*challenge|2-4 .*game/i);
    expect(text).toContain('procedural-skill');
    expect(text).toContain('slide');
    expect(text).toContain('game');
    expect(text).toContain('interactive');
    expect(text).toContain('procedureType');
    expect(text).toContain('task');
    expect(text).toContain('tools');
    expect(text).toContain('steps');
    expect(text).toContain('successCriteria');
    expect(text).toContain('errorConsequences');
  });

  test('asks procedural-skill scenes to vary visual framing without new fields', () => {
    const text = buildTaskEnginePrompt();

    expect(text).toMatch(/training mechanism[\s\S]{0,80}not a fixed UI style/i);
    expect(text).toMatch(/dark checklist|dark dashboard/i);
    expect(text).toMatch(/training format|visual framing/i);
    expect(text).toMatch(/title[\s\S]{0,80}description[\s\S]{0,80}keyPoints/i);
    expect(text).toMatch(
      /light step-card board|work-order desk|safety check station|process kanban|measurement station|control-console style|GO\/STOP decision station/i,
    );
    expect(text).toMatch(/Do not add new schema fields|without adding new JSON fields/i);
    expect(text).toMatch(/first scene must be a `?slide`?/i);
    expect(text).toMatch(/10-14 scenes/i);
    expect(text).toMatch(/mixed structure|mixed vocational/i);
    expect(text).not.toContain('{{');
  });

  test('directs the first scene to start with practice rather than a concept slide', () => {
    const text = buildTaskEnginePrompt();

    expect(text).toMatch(/first scene must be a `?slide`?/i);
    expect(text).toMatch(/course briefing|task overview/i);
    expect(text).toMatch(/task purpose|vocational task purpose/i);
    expect(text).toMatch(/training objectives|what will be trained/i);
    expect(text).toMatch(/key training steps|operation stages/i);
    expect(text).toMatch(/safety boundary|risk reminder/i);
    expect(text).toMatch(/completion criteria|GO-STOP standard/i);
    expect(text).toMatch(/must not be .*checklist|not be a checklist/i);
    expect(text).toMatch(/generic subject introduction|pure theory lecture/i);
    expect(text).toMatch(/do not create .*concept.*slide|not be a generic concept introduction/i);
    expect(text).toMatch(/hands-on|procedural|operation|vocational/i);
    expect(text).toMatch(/pure theory|ordinary concept/i);
    expect(text).toMatch(/not all procedural-skill|Do not make every scene a procedural-skill/i);
    expect(text).not.toContain('{{');
  });

  test('hardens the first briefing slide against dense or unstable layouts', () => {
    const text = buildTaskEnginePrompt();

    expect(text).toMatch(/first scene must be a `?slide`?/i);
    expect(text).toMatch(/course briefing|task overview/i);
    expect(text).toMatch(/stable PPT-style slide/i);
    expect(text).toMatch(/exactly 3 stable information cards|3 stable information cards/i);
    expect(text).toMatch(/Task Purpose/i);
    expect(text).toMatch(/Key Risk/i);
    expect(text).toMatch(/Task Boundary/i);
    expect(text).toMatch(/4-6 macro training stages/i);
    expect(text).toMatch(/compact GO\/STOP completion standard/i);
    expect(text).toMatch(/safety red line/i);
    expect(text).toMatch(/not a floating callout|not be a floating callout/i);
    expect(text).toMatch(/more than 6 training steps/i);
    expect(text).toMatch(/long arrow flowcharts/i);
    expect(text).toMatch(/floating callouts/i);
    expect(text).toMatch(/overlapping GO\/STOP bars/i);
    expect(text).toMatch(/dense dashboards|bottom-heavy dashboards/i);
    expect(text).toMatch(/16:9 slide frame/i);
    expect(text).toMatch(/overflow/i);
    expect(text).not.toContain('{{');
  });

  test('requires playable payload for task-engine game scenes without hard-coding one template', () => {
    const text = buildTaskEnginePrompt();

    expect(text).toMatch(/playable payload/i);
    expect(text).toMatch(/concrete playable objects/i);
    expect(text).toMatch(/correct outcome|target state/i);
    expect(text).toMatch(/wrong-choice feedback/i);
    expect(text).toMatch(/success condition/i);
    expect(text).toMatch(/failure consequence/i);
    expect(text).toMatch(/recommended stable patterns|fallback patterns/i);
    expect(text).toMatch(/sequence-ordering/i);
    expect(text).toMatch(/GO\/STOP decision/i);
    expect(text).toMatch(/risk-classification/i);
    expect(text).toMatch(/tool-matching/i);
    expect(text).toMatch(/5-8 concrete objects|5-8 concrete objects\/cases\/cards/i);
    expect(text).toMatch(/Never provide fewer than 4 playable objects/i);
    expect(text).toMatch(/not the only allowed patterns/i);
    expect(text).not.toMatch(/only these four patterns are allowed/i);
    expect(text).not.toContain('{{');
  });
});
