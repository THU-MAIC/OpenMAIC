import { describe, expect, it, vi } from 'vitest';

import type { AICallFn } from '@openmaic/generation';
import { generateSceneContent } from '@openmaic/generation';
import { quizOutline, slideOutline, widgetOutline } from './scene-fixtures.js';

describe('scene content model-output failures', () => {
  it.each([
    ['slide', slideOutline, JSON.stringify({ background: { type: 'solid', color: '#fff' } })],
    ['quiz', quizOutline, JSON.stringify({ question: 'not an array' })],
    ['interactive', widgetOutline, 'INTERACTIVE_RAW_SENTINEL'],
  ] as const)(
    'reports invalid-model-output before returning null for malformed %s content',
    async (_type, makeOutline, response) => {
      const aiCall: AICallFn = vi.fn(async () => response);
      const failures: unknown[] = [];

      const content = await generateSceneContent(makeOutline(), aiCall, {
        onFailure: (failure: unknown) => failures.push(failure),
      } as never);

      expect(content).toBeNull();
      expect(failures).toEqual([{ code: 'invalid-model-output' }]);
      expect(aiCall).toHaveBeenCalledTimes(1);
    },
  );
});
