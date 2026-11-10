import { describe, expect, test } from 'vitest';

import { generateWidgetContent } from '@openmaic/generation';
import type { AICallFn, SceneOutline } from '@openmaic/generation';

const HTML = '<!DOCTYPE html><html><head></head><body></body></html>';

async function renderUserPrompt(overrides: Partial<SceneOutline>): Promise<string> {
  let captured = '';
  const aiCall: AICallFn = async (_system, user) => {
    captured = user;
    return HTML;
  };
  const outline: SceneOutline = {
    id: 'widget-spec',
    type: 'interactive',
    title: 'Projectile Lab',
    description: 'Explore how launch angle changes range.',
    keyPoints: ['Change the angle', 'Watch the range'],
    order: 1,
    widgetType: 'simulation',
    widgetOutline: { concept: 'Projectile motion' },
    ...overrides,
  };
  await generateWidgetContent(outline, aiCall, 'Teach in English.');
  return captured;
}

function section(prompt: string, heading: string): string {
  const start = prompt.indexOf(`## ${heading}\n`);
  if (start === -1) return '';
  const body = prompt.slice(start + heading.length + 4);
  const end = body.indexOf('\n## ');
  return (end === -1 ? body : body.slice(0, end)).trim();
}

describe('simulation widget spec', () => {
  test('keeps constraints such as step inside a structured range', async () => {
    const prompt = await renderUserPrompt({
      widgetOutline: {
        concept: 'Projectile motion',
        keyVariables: [{ name: 'speed', range: { min: 0, max: 100, step: 5 }, unit: 'm/s' }],
      },
    });
    expect(section(prompt, 'Variables to Expose')).toBe('speed (0–100, step: 5, m/s)');
  });

  test('formats object variables as readable text and keeps plain strings', async () => {
    const prompt = await renderUserPrompt({
      widgetOutline: {
        concept: 'Projectile motion',
        keyVariables: [
          { name: 'Launch angle', range: [0, 90], unit: 'deg', default: 45 },
          { name: 'Initial speed', min: 5, max: 30, unit: 'm/s' },
          'gravity',
        ],
      },
    });

    expect(prompt).not.toContain('[object Object]');
    expect(section(prompt, 'Variables to Expose')).toBe(
      'Launch angle (0–90, deg, default: 45), Initial speed (5–30, m/s), gravity',
    );
  });

  test('keeps plain string variables unchanged', async () => {
    const prompt = await renderUserPrompt({
      widgetOutline: { concept: 'Projectile motion', keyVariables: ['angle', 'velocity'] },
    });

    expect(section(prompt, 'Variables to Expose')).toBe('angle, velocity');
    expect(prompt).not.toContain('## Additional Design Requirements');
  });

  test('takes the design idea from the widget outline, then the legacy config', async () => {
    const fromWidget = await renderUserPrompt({
      widgetOutline: { concept: 'Projectile motion', designIdea: 'A cannon on a hill.' },
      interactiveConfig: {
        conceptName: 'Projectile motion',
        conceptOverview: 'Range vs angle',
        designIdea: 'Legacy idea.',
      },
    });
    expect(section(fromWidget, 'Design Idea')).toBe('A cannon on a hill.');

    const fromConfig = await renderUserPrompt({
      interactiveConfig: {
        conceptName: 'Projectile motion',
        conceptOverview: 'Range vs angle',
        designIdea: 'Drag the cannon barrel to aim.',
      },
    });
    expect(section(fromConfig, 'Design Idea')).toBe('Drag the cannon barrel to aim.');
  });

  test('passes unmodelled outline fields through as additional design requirements', async () => {
    const prompt = await renderUserPrompt({
      widgetOutline: {
        concept: 'Projectile motion',
        keyVariables: ['angle'],
        controls: ['Angle slider', { name: 'Fire button', action: 'launch the ball' }],
        readouts: [{ label: 'Range', unit: 'm' }, 'Flight time'],
        layout: { canvas: 'left', panel: 'right' },
        emptyList: [],
        nothing: null,
      },
    });

    expect(section(prompt, 'Additional Design Requirements')).toBe(
      [
        '- Controls:',
        '  - Angle slider',
        '  - Fire button (action: launch the ball)',
        '- Readouts:',
        '  - Range (m)',
        '  - Flight time',
        '- Layout:',
        '  - canvas: left',
        '  - panel: right',
      ].join('\n'),
    );
    // The section sits before the language directive, not after the mandatory checklist.
    expect(prompt.indexOf('## Additional Design Requirements')).toBeLessThan(
      prompt.indexOf('## Language'),
    );
  });
});

describe('other widget specs', () => {
  test('game outlines keep the challenge and player controls', async () => {
    const prompt = await renderUserPrompt({
      widgetType: 'game',
      widgetOutline: {
        concept: 'Projectile motion',
        gameType: 'action',
        challenge: 'Hit the target in three shots',
        playerControls: ['angle', 'power'],
      },
    });

    expect(section(prompt, 'Additional Design Requirements')).toBe(
      [
        '- Concept: Projectile motion',
        '- Challenge: Hit the target in three shots',
        '- Player controls:',
        '  - angle',
        '  - power',
      ].join('\n'),
    );
  });

  test('non-simulation widgets carry the legacy design idea and skip a title-only concept', async () => {
    const prompt = await renderUserPrompt({
      widgetType: 'diagram',
      widgetOutline: { concept: 'Projectile Lab', diagramType: 'flowchart' },
      interactiveConfig: {
        conceptName: 'Projectile Lab',
        conceptOverview: 'Flow of a launch',
        designIdea: 'Step through launch, flight and landing.',
      },
    });

    expect(section(prompt, 'Additional Design Requirements')).toBe(
      '- Design idea: Step through launch, flight and landing.',
    );
  });

  test('omits the section entirely when nothing is left over', async () => {
    const prompt = await renderUserPrompt({
      widgetType: 'code',
      widgetOutline: { concept: 'Projectile Lab', language: 'python' },
    });

    expect(prompt).not.toContain('Additional Design Requirements');
    expect(prompt).not.toContain('{{');
  });
});
