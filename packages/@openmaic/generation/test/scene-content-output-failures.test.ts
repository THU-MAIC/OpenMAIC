import { describe, expect, it, vi } from 'vitest';

import type { AICallFn, GenerationLogger, SceneContentFailure } from '@openmaic/generation';
import { generateSceneContent, generateWidgetContent } from '@openmaic/generation';
import { pblOutline, quizOutline, slideOutline, widgetOutline } from './scene-fixtures.js';

const silentLogger: GenerationLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

describe('scene content model-output failures', () => {
  it.each([
    ['slide', slideOutline, JSON.stringify({ background: { type: 'solid', color: '#fff' } })],
    ['quiz', quizOutline, JSON.stringify({ question: 'not an array' })],
    ['interactive', widgetOutline, 'INTERACTIVE_RAW_SENTINEL'],
  ] as const)(
    'reports invalid-model-output before returning null for malformed %s content',
    async (_type, makeOutline, response) => {
      const aiCall: AICallFn = vi.fn(async () => response);
      const failures: SceneContentFailure[] = [];

      const content = await generateSceneContent(makeOutline(), aiCall, {
        onFailure: (failure) => failures.push(failure),
      });

      expect(content).toBeNull();
      expect(failures).toEqual([{ code: 'invalid-model-output' }]);
      expect(aiCall).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects interactive HTML whose classic inline JavaScript cannot parse', async () => {
    const errors: string[] = [];
    const aiCall: AICallFn = vi.fn(
      async () =>
        '<!DOCTYPE html><html><head></head><body><button id="start">Start Simulation</button><script type="application/json" id="widget-config">{"type":"simulation"}</script><script>state counts = new Array(10).fill(0);</script></body></html>',
    );
    const failures: SceneContentFailure[] = [];

    const content = await generateSceneContent(widgetOutline(), aiCall, {
      logger: {
        ...silentLogger,
        error(message) {
          errors.push(String(message));
        },
      },
      onFailure: (failure) => failures.push(failure),
    });

    expect(content).toBeNull();
    expect(failures).toEqual([{ code: 'invalid-model-output' }]);
    expect(aiCall).toHaveBeenCalledTimes(1);
    expect(
      errors.some((message) => message.includes('script #2') && message.includes('counts')),
    ).toBe(true);
  });

  it.each([
    [
      'a quoted greater-than in a script attribute',
      '<script data-note="a > b">window.widgetRan = true;</script>',
    ],
    [
      'a non-executable script hidden in an HTML comment',
      '<!-- <script>state counts = [];</script> --><script>window.widgetRan = true;</script>',
    ],
  ])(
    'accepts interactive HTML with %s instead of invalid-model-output',
    async (_label, fragment) => {
      const response = `<!DOCTYPE html><html><head></head><body>${fragment}</body></html>`;
      const runs = [
        (aiCall: AICallFn, onFailure: (failure: SceneContentFailure) => void) =>
          generateSceneContent(widgetOutline(), aiCall, { onFailure }),
        (aiCall: AICallFn, onFailure: (failure: SceneContentFailure) => void) =>
          generateWidgetContent(widgetOutline(), aiCall, undefined, { onFailure }),
      ];

      for (const generate of runs) {
        const aiCall: AICallFn = vi.fn(async () => response);
        const failures: SceneContentFailure[] = [];
        const content = await generate(aiCall, (failure) => failures.push(failure));

        expect(content).toMatchObject({
          widgetType: 'simulation',
          html: expect.stringContaining('window.widgetRan = true;'),
        });
        expect(failures).toEqual([]);
        expect(aiCall).toHaveBeenCalledTimes(1);
      }
    },
  );

  it('rejects a top-level return in classic inline JavaScript', async () => {
    const aiCall: AICallFn = vi.fn(
      async () => '<!DOCTYPE html><html><head></head><body><script>return;</script></body></html>',
    );
    const failures: SceneContentFailure[] = [];

    const content = await generateSceneContent(widgetOutline(), aiCall, {
      onFailure: (failure) => failures.push(failure),
    });

    expect(content).toBeNull();
    expect(failures).toEqual([{ code: 'invalid-model-output' }]);
  });

  it('does not classify capability gates, PBL failures, or provider exceptions', async () => {
    const gateFailures: SceneContentFailure[] = [];
    const gateAiCall: AICallFn = vi.fn();
    const proceduralOutline = {
      ...widgetOutline(),
      widgetType: 'procedural-skill' as const,
      widgetOutline: { concept: 'Calibrate a device' },
    };

    await expect(
      generateSceneContent(proceduralOutline, gateAiCall, {
        onFailure: (failure) => gateFailures.push(failure),
      }),
    ).resolves.toBeNull();
    expect(gateFailures).toEqual([]);
    expect(gateAiCall).not.toHaveBeenCalled();

    const pblFailures: SceneContentFailure[] = [];
    await expect(
      generateSceneContent(
        pblOutline(),
        async () => {
          throw new Error('PBL_PROVIDER_SENTINEL');
        },
        { onFailure: (failure) => pblFailures.push(failure) },
      ),
    ).rejects.toMatchObject({ name: 'PBLGenerationError' });
    expect(pblFailures).toEqual([]);

    const providerFailures: SceneContentFailure[] = [];
    await expect(
      generateSceneContent(
        slideOutline(),
        async () => {
          throw new Error('SLIDE_PROVIDER_SENTINEL');
        },
        { onFailure: (failure) => providerFailures.push(failure) },
      ),
    ).rejects.toThrow('SLIDE_PROVIDER_SENTINEL');
    expect(providerFailures).toEqual([]);
  });
});
