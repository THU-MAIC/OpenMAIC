import { expect, it } from 'vitest';
import type { AICallFn } from '@openmaic/generation';
import { generateSceneContent } from '@openmaic/generation';
import {
  pblOutline,
  quizOutline,
  slideOutline,
  validPBLResponse,
  widgetOutline,
} from './scene-fixtures.js';

it('pins representative system and user prompts for every scene kind', async () => {
  const captured: Record<string, { system: string; user: string }> = {};

  const capture =
    (kind: string, response: string): AICallFn =>
    async (system, user) => {
      captured[kind] = { system, user };
      return response;
    };

  await generateSceneContent(
    slideOutline(),
    capture(
      'slide',
      JSON.stringify({ elements: [], background: { type: 'solid', color: '#fff' } }),
    ),
    { languageDirective: 'Teach in English.' },
  );
  await generateSceneContent(quizOutline(), capture('quiz', '[]'), {
    languageDirective: 'Teach in English.',
  });
  await generateSceneContent(
    widgetOutline(),
    capture('interactive', '<!DOCTYPE html><html><head></head><body></body></html>'),
    { languageDirective: 'Teach in English.' },
  );
  // Agent-authored outlines carry structured variables and fields that no
  // widget slot models; pin how they read in the page writer's user prompt.
  const structured = widgetOutline();
  structured.widgetOutline = {
    concept: 'Energy transfer',
    designIdea: 'A ball rolls down a ramp; bars show kinetic and potential energy.',
    keyVariables: [
      { name: 'Ramp height', range: [0.5, 3], unit: 'm' },
      { name: 'Friction', min: 0, max: 0.5 },
      'mass',
    ],
    controls: ['Height slider', 'Release button'],
    readouts: [{ name: 'Kinetic energy', unit: 'J' }, 'Speed at the bottom'],
  };
  await generateSceneContent(
    structured,
    capture('interactive-structured', '<!DOCTYPE html><html><head></head><body></body></html>'),
    { languageDirective: 'Teach in English.' },
  );
  await generateSceneContent(pblOutline(), capture('pbl', validPBLResponse()), {
    languageDirective: 'Reply in English.',
    targetLanguage: 'en-US',
  });

  const { 'interactive-structured': structuredPrompts, ...representative } = captured;
  expect(representative).toMatchSnapshot();
  expect(structuredPrompts?.user).toMatchSnapshot();
});

it('documents the ShapeElement rotation geometry contract in the generated prompt', async () => {
  let systemPrompt = '';
  const capture: AICallFn = async (system) => {
    systemPrompt = system;
    return JSON.stringify({ elements: [], background: { type: 'solid', color: '#fff' } });
  };

  await generateSceneContent(slideOutline(), capture);

  expect(systemPrompt).not.toContain('"rotate": 30');
  expect(systemPrompt).toContain(
    '`rotate`: finite angle in degrees; positive values rotate clockwise around the centre of the unrotated bounding box',
  );
});
