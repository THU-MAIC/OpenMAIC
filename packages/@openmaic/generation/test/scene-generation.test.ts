import { describe, expect, it, vi } from 'vitest';
import type { AICallFn } from '@openmaic/generation';
import {
  PBLGenerationError,
  extractWidgetConfig,
  generateSceneActions,
  generateSceneContent,
} from '@openmaic/generation';
import {
  pblOutline,
  quizOutline,
  slideOutline,
  validPBLResponse,
  widgetOutline,
} from './scene-fixtures.js';

describe('scene generation primitives', () => {
  it('recovers malformed required geometry types before normalization can discard a valid label', async () => {
    const content = await generateSceneContent(slideOutline(), async () =>
      JSON.stringify({
        elements: [
          {
            type: 'shape',
            left: 20,
            top: 30,
            width: 100,
            height: 80,
            path: 123,
            viewBox: '0 0 100 80',
            rotate: -30,
            text: { content: '<p>Preserve label</p>' },
          },
        ],
      }),
    );
    expect(content).toMatchObject({
      elements: [
        {
          type: 'text',
          content: '<p>Preserve label</p>',
          left: 20,
          top: 30,
          width: 100,
          height: 80,
          rotate: -30,
        },
      ],
    });
  });
  it('recovers invalid shapes as bounded text while retaining valid neighboring elements', async () => {
    const shape = {
      type: 'shape',
      left: 0,
      top: 0,
      width: 100,
      height: 100,
      viewBox: [100, 100],
      fill: '#fff',
      fixedRatio: false,
    };
    const content = await generateSceneContent(slideOutline(), async () =>
      JSON.stringify({
        elements: [
          { ...shape, path: 'M0 0 Z1 1' },
          {
            ...shape,
            path: 'M0 0 L1e999 0',
            rotate: 45,
            groupId: 'labels',
            opacity: 0,
            text: {
              content: '<p>Keep this explanation</p>',
              align: 'middle',
              defaultFontName: 'Inter',
              defaultColor: '#000',
            },
          },
          {
            ...shape,
            width: 1e100,
            path: 'M0 0 L100 0 L50 100 Z',
            text: { content: '<p>Recover within size limits</p>' },
          },
          {
            ...shape,
            viewBox: [0, 0],
            path: 'M0 0 L100 0 L50 100 Z',
            text: { content: '<p>Recover a zero-viewBox label</p>' },
          },
          { ...shape, path: 'M0 0 L100 0 L50 100 Z' },
          { type: 'text', left: 0, top: 120, width: 100, height: 40, content: '<p>Valid text</p>' },
        ],
      }),
    );
    expect(content).toMatchObject({
      elements: [
        {
          type: 'text',
          content: '<p>Keep this explanation</p>',
          vAlign: 'middle',
          rotate: 45,
          groupId: 'labels',
          opacity: 0,
        },
        { type: 'text', content: '<p>Recover within size limits</p>', width: 4000 },
        { type: 'text', content: '<p>Recover a zero-viewBox label</p>' },
        { type: 'shape', path: 'M0 0 L100 0 L50 100 Z' },
        { type: 'text', content: '<p>Valid text</p>' },
      ],
    });
  });

  it('generates slide content through the injected AI call', async () => {
    const aiCall: AICallFn = vi.fn(async () =>
      JSON.stringify({
        elements: [
          {
            type: 'text',
            left: 80,
            top: 60,
            width: 840,
            height: 100,
            content: 'Dependency injection',
          },
        ],
        background: { type: 'solid', color: '#ffffff' },
      }),
    );

    const content = await generateSceneContent(slideOutline(), aiCall);
    expect(content).toMatchObject({
      elements: [expect.objectContaining({ type: 'text', content: 'Dependency injection' })],
      background: { type: 'solid', color: '#ffffff' },
    });
    expect(aiCall).toHaveBeenCalledTimes(1);
  });

  it.each([30, -45])('keeps ordinary generated text upright despite rotate=%s', async (rotate) => {
    const content = await generateSceneContent(slideOutline(), async () =>
      JSON.stringify({
        elements: [
          {
            type: 'text',
            left: 20,
            top: 30,
            width: 200,
            height: 80,
            content: '<p>Ordinary text</p>',
            rotate,
          },
        ],
      }),
    );
    expect(content).toMatchObject({ elements: [{ type: 'text', rotate: 0 }] });
  });

  it.each([0, 36.5, -12.25])(
    'preserves finite rotation %s supplied for generated shapes',
    async (rotate) => {
      const aiCall: AICallFn = vi.fn(async () =>
        JSON.stringify({
          elements: [
            {
              type: 'shape',
              left: 320,
              top: 70,
              width: 300,
              height: 300,
              path: 'M 0 0 L 1 0 L 1 1 L 0 1 Z',
              viewBox: [1, 1],
              fill: '#5b9bd5',
              fixedRatio: false,
              rotate,
            },
          ],
        }),
      );

      const content = await generateSceneContent(slideOutline(), aiCall);
      expect(content).not.toBeNull();
      if (!content || !('elements' in content)) throw new Error('expected slide content');
      expect(content.elements[0]).toMatchObject({ type: 'shape', rotate });
    },
  );

  it('rejects an invalid shape rotation with a diagnostic', async () => {
    const aiCall: AICallFn = vi.fn(async () =>
      JSON.stringify({
        elements: [
          {
            type: 'shape',
            left: 320,
            top: 70,
            width: 300,
            height: 300,
            path: 'M 0 0 L 1 0 L 1 1 L 0 1 Z',
            viewBox: [1, 1],
            fill: '#5b9bd5',
            rotate: 'thirty-six degrees',
          },
        ],
      }),
    );
    const failures: Array<{ code: string; message?: string }> = [];

    const content = await generateSceneContent(slideOutline(), aiCall, {
      onFailure: (failure) => failures.push(failure),
    });

    expect(content).toBeNull();
    expect(failures).toEqual([
      {
        code: 'invalid-model-output',
        message: expect.stringContaining('shape[0].rotate'),
      },
    ]);
  });

  it('reports non-finite shape rotations by value', async () => {
    const aiCall: AICallFn = vi.fn(
      async () =>
        '{"elements":[{"type":"shape","left":320,"top":70,"width":300,"height":300,"path":"M 0 0 L 1 0 L 1 1 L 0 1 Z","viewBox":[1,1],"fill":"#5b9bd5","rotate":1e400}]}',
    );
    const failures: Array<{ code: string; message?: string }> = [];

    const content = await generateSceneContent(slideOutline(), aiCall, {
      onFailure: (failure) => failures.push(failure),
    });

    expect(content).toBeNull();
    expect(failures[0]?.message).toContain('received Infinity');
  });

  it('skips null elements before validating shape rotations', async () => {
    const aiCall: AICallFn = vi.fn(async () => '{"elements":[null]}');

    const content = await generateSceneContent(slideOutline(), aiCall);

    expect(content).not.toBeNull();
    if (!content || !('elements' in content)) throw new Error('expected slide content');
    expect(content.elements).toEqual([]);
  });

  it('treats a null shape rotation as the missing-angle default', async () => {
    const aiCall: AICallFn = vi.fn(async () =>
      JSON.stringify({
        elements: [
          {
            type: 'shape',
            left: 320,
            top: 70,
            width: 300,
            height: 300,
            path: 'M 0 0 L 1 0 L 1 1 L 0 1 Z',
            viewBox: [1, 1],
            fill: '#5b9bd5',
            rotate: null,
          },
        ],
      }),
    );

    const content = await generateSceneContent(slideOutline(), aiCall);
    expect(content).not.toBeNull();
    if (!content || !('elements' in content)) throw new Error('expected slide content');
    expect(content.elements[0]).toMatchObject({ type: 'shape', rotate: 0 });
  });

  it('generates quiz content through the json-output-rules prompt path', async () => {
    let system = '';
    const aiCall: AICallFn = async (systemPrompt) => {
      system = systemPrompt;
      return JSON.stringify([
        {
          type: 'single',
          question: 'Who owns model routing?',
          options: ['The caller', 'The package'],
          correctAnswer: 'A',
        },
      ]);
    };

    const content = await generateSceneContent(quizOutline(), aiCall);
    expect(system).toContain('Output Format Requirements (Must Follow Strictly)');
    expect(content).toMatchObject({
      questions: [
        expect.objectContaining({
          type: 'single',
          options: [
            { value: 'A', label: 'The caller' },
            { value: 'B', label: 'The package' },
          ],
          answer: ['A'],
        }),
      ],
    });
  });

  it('runs one widget kind end-to-end through config extraction and actions', async () => {
    let calls = 0;
    const aiCall: AICallFn = async () => {
      calls += 1;
      if (calls === 1) {
        return '<!DOCTYPE html><html><head></head><body><input id="energy" type="range"><script type="application/json" id="widget-config">{"variables":["energy"]}</script></body></html>';
      }
      return JSON.stringify([
        { type: 'action', name: 'widget_highlight', params: { target: '#energy' } },
        { type: 'action', name: 'widget_setState', params: { state: { energy: 75 } } },
      ]);
    };

    const outline = widgetOutline();
    const content = await generateSceneContent(outline, aiCall);
    expect(content).toMatchObject({
      widgetType: 'simulation',
      widgetConfig: { type: 'simulation', variables: ['energy'] },
    });
    if (!content || !('html' in content)) throw new Error('expected interactive content');
    expect(extractWidgetConfig(content.html, 'simulation')).toEqual({
      type: 'simulation',
      variables: ['energy'],
    });
    const actions = await generateSceneActions(outline, content, aiCall);
    expect(actions.map((action) => action.type)).toEqual(['widget_highlight', 'widget_setState']);
  });

  it('generates PBL content with the re-seated single-call planner', async () => {
    const content = await generateSceneContent(pblOutline(), async () => validPBLResponse(), {
      targetLanguage: 'en-US',
      languageDirective: 'Reply in English.',
    });
    expect(content).toMatchObject({
      projectV2: {
        title: 'CSV Data Analyzer project',
        status: 'active',
        uiPhase: 'hero',
      },
    });
  });

  it('fails loudly when PBL single-call planning fails and no fallback exists', async () => {
    await expect(
      generateSceneContent(pblOutline(), async () => {
        throw new Error('model unavailable');
      }),
    ).rejects.toBeInstanceOf(PBLGenerationError);
  });

  it('invokes the injected PBL loop fallback after a single-call failure', async () => {
    const fallback = vi.fn(async () => ({
      uiPhase: 'hero' as const,
      title: 'Recovered project',
      description: 'Recovered by the host loop planner.',
      tags: [],
      language: 'en-US',
      proficiency: 'beginner' as const,
      status: 'active' as const,
      roles: [],
      milestones: [],
      submissions: [],
      evaluations: [],
      threads: [],
      engagementEvents: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }));

    const content = await generateSceneContent(pblOutline(), async () => '{}', {
      pblLoopFallback: fallback,
    });
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(content).toMatchObject({ projectV2: { title: 'Recovered project' } });
  });

  it('skips the PBL loop fallback after a single-call abort', async () => {
    const fallback = vi.fn();

    await expect(
      generateSceneContent(
        pblOutline(),
        async () => {
          throw new DOMException('The operation was aborted.', 'AbortError');
        },
        { pblLoopFallback: fallback },
      ),
    ).rejects.toMatchObject({
      name: 'PBLGenerationError',
      message: expect.stringContaining('after all planner attempts'),
      cause: expect.objectContaining({ name: 'AbortError' }),
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  it('skips the PBL loop fallback after an error-shaped single-call abort', async () => {
    const fallback = vi.fn();

    await expect(
      generateSceneContent(
        pblOutline(),
        async () => {
          throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
        },
        { pblLoopFallback: fallback },
      ),
    ).rejects.toMatchObject({
      name: 'PBLGenerationError',
      message: expect.stringContaining('after all planner attempts'),
      cause: expect.objectContaining({ name: 'AbortError', message: 'Aborted' }),
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  it('skips the PBL loop fallback after a status-bearing provider failure', async () => {
    const fallback = vi.fn();

    await expect(
      generateSceneContent(
        pblOutline(),
        async () => {
          throw Object.assign(new Error('rate limited'), { status: 429 });
        },
        { pblLoopFallback: fallback },
      ),
    ).rejects.toMatchObject({
      name: 'PBLGenerationError',
      message: expect.stringContaining('after all planner attempts'),
      statusCode: 429,
      cause: expect.objectContaining({ message: 'rate limited', status: 429 }),
    });
    expect(fallback).not.toHaveBeenCalled();
  });
});
