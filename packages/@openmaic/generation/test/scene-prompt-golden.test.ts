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
