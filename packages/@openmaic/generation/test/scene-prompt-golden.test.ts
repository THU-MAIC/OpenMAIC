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
  await generateSceneContent(pblOutline(), capture('pbl', validPBLResponse()), {
    languageDirective: 'Reply in English.',
    targetLanguage: 'en-US',
  });

  expect(captured).toMatchSnapshot();
});

it('documents the ShapeElement rotation geometry contract in the generated prompt', async () => {
  let systemPrompt = '';
  const capture: AICallFn = async (system) => {
    systemPrompt = system;
    return JSON.stringify({ elements: [], background: { type: 'solid', color: '#fff' } });
  };

  await generateSceneContent(slideOutline(), capture);

  expect(systemPrompt).toContain('"rotate": 30');
  expect(systemPrompt).toContain(
    '`rotate`: finite angle in degrees; positive values rotate clockwise around the centre of the unrotated bounding box',
  );
});
