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

  expect(Object.keys(captured).sort()).toEqual(['interactive', 'pbl', 'quiz', 'slide']);
  for (const { system } of Object.values(captured)) {
    expect(system).toContain('## Unconditional Visual Quality Contract');
    expect(system).toContain('1280x720');
    expect(system).toContain('768x720');
    expect(system).toContain('390x844');
    expect(system).toContain('no document-level horizontal or vertical overflow');
    expect(system).toContain('No text may clip or overflow its container');
  }

  expect(captured).toMatchSnapshot();
});
